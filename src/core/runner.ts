import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { childEnv } from './child-env.js';
import type { CreateJobInput, Job, JobEvent, JobUsage } from './types.js';

/** stream-json 한 줄을 느슨하게 표현한 타입. CLI 스키마 변화에 견디도록 optional로 둔다. */
interface StreamLine {
  type?: string;
  subtype?: string;
  session_id?: string;
  cwd?: string;
  model?: string;
  result?: string;
  is_error?: boolean;
  num_turns?: number;
  duration_ms?: number;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  message?: {
    model?: string;
    content?: Array<{
      type?: string;
      text?: string;
      thinking?: string;
      name?: string;
      input?: unknown;
      is_error?: boolean;
      content?: unknown;
    }>;
  };
}

/** CLI 인자를 조립한다. 사용자 입력은 전부 개별 argv 원소로 넘어가므로 셸 인젝션 위험이 없다. */
export function buildArgs(input: CreateJobInput): string[] {
  const args = [
    '-p',
    input.prompt,
    '--output-format',
    'stream-json',
    // stream-json 출력에는 --verbose가 필요하다.
    '--verbose',
  ];

  if (input.resumeSessionId) args.push('--resume', input.resumeSessionId);
  if (input.model) args.push('--model', input.model);
  if (input.permissionMode) args.push('--permission-mode', input.permissionMode);
  if (input.maxTurns != null) args.push('--max-turns', String(input.maxTurns));
  if (input.appendSystemPrompt) args.push('--append-system-prompt', input.appendSystemPrompt);
  if (input.allowedTools?.length) args.push('--allowedTools', ...input.allowedTools);
  if (input.disallowedTools?.length) args.push('--disallowedTools', ...input.disallowedTools);

  return args;
}

/**
 * 개행 단위로 JSON을 잘라내는 버퍼.
 * stdout 청크가 JSON 경계와 무관하게 쪼개지므로 직접 재조립해야 한다.
 */
class LineBuffer {
  private buf = '';

  push(chunk: string, onLine: (line: string) => void): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (line) onLine(line);
    }
  }

  flush(onLine: (line: string) => void): void {
    const rest = this.buf.trim();
    this.buf = '';
    if (rest) onLine(rest);
  }
}

export interface RunHandle {
  job: Job;
  events: EventEmitter;
  cancel(): void;
  done: Promise<Job>;
}

/**
 * Claude Code CLI를 자식 프로세스로 실행하고 stream-json을 파싱한다.
 * 이벤트는 events에서 'event'로 흘러나오고, 최종 Job은 done으로 확정된다.
 */
export function runClaude(params: {
  jobId?: string;
  cwd: string;
  workspaceId: string;
  input: CreateJobInput;
}): RunHandle {
  const { cwd, workspaceId, input } = params;
  const jobId = params.jobId ?? randomUUID();
  const events = new EventEmitter();

  const { workspaceId: _w, prompt: _p, ...options } = input;
  const job: Job = {
    id: jobId,
    status: 'running',
    workspaceId,
    cwd,
    prompt: input.prompt,
    toolCalls: [],
    metadata: input.metadata,
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    options,
  };

  const emit = (event: JobEvent): void => {
    events.emit('event', event);
  };

  const args = buildArgs(input);
  // stdin은 'ignore'이므로 stdout/stderr만 스트림으로 잡힌다.
  let child: ChildProcessByStdio<null, Readable, Readable>;
  try {
    child = spawn(config.claudeBin, args, {
      cwd,
      // 매니저·relay 비밀값은 빼고 넘긴다. child-env.ts 참고.
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    job.status = 'failed';
    job.error = `CLI 실행 실패: ${(err as Error).message}`;
    job.finishedAt = new Date().toISOString();
    emit({ type: 'result', jobId, job, at: job.finishedAt });
    return {
      job,
      events,
      cancel: () => {},
      done: Promise.resolve(job),
    };
  }

  const timeoutMs = input.timeoutMs ?? config.defaultTimeoutMs;
  let settled = false;
  let canceled = false;
  let timedOut = false;
  let sawResultLine = false;

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    // 정리에 응답하지 않으면 강제 종료한다.
    setTimeout(() => child.kill('SIGKILL'), 5000).unref();
  }, timeoutMs);

  const handleLine = (line: string): void => {
    let msg: StreamLine;
    try {
      msg = JSON.parse(line) as StreamLine;
    } catch {
      return; // JSON이 아닌 출력은 무시한다.
    }
    const at = new Date().toISOString();

    if (msg.type === 'system' && msg.subtype === 'init') {
      if (msg.session_id) {
        job.sessionId = msg.session_id;
        emit({
          type: 'session',
          jobId,
          sessionId: msg.session_id,
          cwd: msg.cwd ?? cwd,
          model: msg.model,
          at,
        });
      }
      return;
    }

    if (msg.type === 'assistant' && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === 'text' && block.text) {
          emit({ type: 'assistant', jobId, text: block.text, at });
        } else if (block.type === 'thinking' && block.thinking) {
          emit({ type: 'thinking', jobId, text: block.thinking, at });
        } else if (block.type === 'tool_use' && block.name) {
          job.toolCalls.push({ name: block.name, input: block.input, at });
          emit({ type: 'tool_use', jobId, name: block.name, input: block.input, at });
        }
      }
      return;
    }

    if (msg.type === 'user' && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === 'tool_result') {
          emit({ type: 'tool_result', jobId, isError: block.is_error === true, at });
        }
      }
      return;
    }

    if (msg.type === 'result') {
      sawResultLine = true;
      job.result = msg.result;
      if (msg.session_id) job.sessionId = msg.session_id;
      const usage: JobUsage = {
        costUsd: msg.total_cost_usd,
        inputTokens: msg.usage?.input_tokens,
        outputTokens: msg.usage?.output_tokens,
        cacheReadInputTokens: msg.usage?.cache_read_input_tokens,
        cacheCreationInputTokens: msg.usage?.cache_creation_input_tokens,
        numTurns: msg.num_turns,
        durationMs: msg.duration_ms,
      };
      job.usage = usage;
      if (msg.is_error) {
        job.error = msg.result ?? 'CLI가 오류를 보고했습니다.';
      }
    }
  };

  const outBuf = new LineBuffer();
  const errBuf = new LineBuffer();
  let stderrText = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => outBuf.push(chunk, handleLine));

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderrText += chunk;
    errBuf.push(chunk, (line) => {
      emit({ type: 'stderr', jobId, text: line, at: new Date().toISOString() });
    });
  });

  const done = new Promise<Job>((resolve) => {
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      outBuf.flush(handleLine);
      errBuf.flush(() => {});

      job.exitCode = exitCode ?? undefined;
      job.finishedAt = new Date().toISOString();

      if (timedOut) {
        job.status = 'timeout';
        job.error ??= `제한 시간(${timeoutMs}ms)을 초과했습니다.`;
      } else if (canceled) {
        job.status = 'canceled';
        job.error ??= '사용자가 취소했습니다.';
      } else if (exitCode === 0 && !job.error) {
        job.status = 'succeeded';
      } else {
        job.status = 'failed';
        if (!job.error) {
          job.error = sawResultLine
            ? `CLI가 코드 ${exitCode}로 종료되었습니다.`
            : stderrText.trim() || `CLI가 결과 없이 코드 ${exitCode}로 종료되었습니다.`;
        }
      }

      emit({ type: 'status', jobId, status: job.status, at: job.finishedAt });
      emit({ type: 'result', jobId, job, at: job.finishedAt });
      resolve(job);
    };

    child.on('error', (err) => {
      job.error = `CLI 실행 오류: ${err.message}`;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });

  return {
    job,
    events,
    cancel: () => {
      canceled = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    },
    done,
  };
}
