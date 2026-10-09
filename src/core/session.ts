import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Readable, Writable } from 'node:stream';
import { config } from './config.js';
import { evaluate, summarize, type PolicyMode } from './policy.js';
import { buildMemoryPrompt, collectMemory, type MemoryFile } from './claude-md.js';
import { history } from './history.js';
import { childEnv } from './child-env.js';
import { runtime } from './runtime.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export type SessionStatus = 'starting' | 'idle' | 'busy' | 'waiting' | 'closed';

/** 사용자 결정을 기다리는 권한 요청. */
export interface PendingPermission {
  id: string;
  toolName: string;
  input: unknown;
  summary: string;
  reason: string;
  at: string;
  resolve: (decision: { behavior: 'allow' | 'deny'; message?: string }) => void;
}

export interface SessionInfo {
  id: string;
  workspaceId: string;
  cwd: string;
  /** 목록에서 세션을 알아볼 이름. 기본은 첫 프롬프트에서 딴다. */
  title?: string;
  status: SessionStatus;
  claudeSessionId?: string;
  policyMode: PolicyMode;
  createdAt: string;
  lastActivityAt: string;
  turns: number;
  totalCostUsd: number;
  pending: Array<Omit<PendingPermission, 'resolve'>>;
  /** 주입된 CLAUDE.md 목록. */
  memory: Array<{ scope: string; path: string }>;
  /**
   * 이 세션에서 쓸 수 있는 / 명령(기본 명령·스킬, / 없이). CLI가 시작할 때 알려 준다 —
   * 첫 입력을 받은 뒤에 오므로 그 전에는 비어 있다. 안경은 여기서 골라 보낸다.
   */
  slashCommands: string[];
}

export interface SessionEvent {
  type:
    | 'status'
    | 'session'
    | 'user'
    | 'assistant'
    | 'thinking'
    | 'tool_use'
    | 'tool_result'
    | 'permission_request'
    | 'permission_resolved'
    | 'turn_complete'
    | 'stderr'
    | 'closed';
  sessionId: string;
  at: string;
  [key: string]: unknown;
}

interface StreamLine {
  type?: string;
  subtype?: string;
  session_id?: string;
  cwd?: string;
  model?: string;
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  num_turns?: number;
  slash_commands?: string[];
  message?: {
    content?: Array<{
      type?: string;
      text?: string;
      thinking?: string;
      name?: string;
      input?: unknown;
      is_error?: boolean;
    }>;
  };
}

/**
 * Claude Code CLI 프로세스를 살려둔 채 대화를 이어가는 세션.
 *
 * - stdin으로 계속 입력을 주입한다 (--input-format stream-json)
 * - 권한 요청은 MCP 서버를 거쳐 매니저로 오고, 사용자 결정까지 블로킹된다
 * - 한 턴이 끝나면 turn_complete 이벤트가 나간다
 */
export class Session {
  readonly id = randomUUID();
  /**
   * 권한 MCP 서버가 이 세션의 권한을 물을 때 내는 키.
   *
   * 예전에는 매니저의 API 키를 그대로 넘겼다. MCP 설정은 명령줄 인자라
   * ps로 보이고, 그 키면 매니저의 모든 것을 할 수 있었다. 이 키로는
   * 이 세션의 권한을 "묻는" 것밖에 못 한다. 승인은 여전히 사람이 한다.
   */
  readonly permToken = randomBytes(32).toString('hex');
  readonly events = new EventEmitter();

  private child?: ChildProcessByStdio<Writable, Readable, Readable>;
  private buf = '';
  private status: SessionStatus = 'starting';
  private claudeSessionId?: string;
  private readonly pending = new Map<string, PendingPermission>();
  private turns = 0;
  private totalCostUsd = 0;
  private slashCommands: string[] = [];
  private createdAt = new Date().toISOString();
  private lastActivityAt = this.createdAt;
  private closed = false;
  private title?: string;
  /** 현재 턴이 끝나기를 기다리는 대기자들. */
  private turnWaiters: Array<(payload: { result?: string; isError: boolean }) => void> = [];

  constructor(
    readonly workspaceId: string,
    readonly cwd: string,
    private policyMode: PolicyMode,
    private readonly options: {
      model?: string;
      permissionMode?: string;
      appendSystemPrompt?: string;
      resumeSessionId?: string;
      /** false면 CLAUDE.md를 주입하지 않는다. 기본은 true. */
      loadMemory?: boolean;
    } = {},
  ) {
    this.events.setMaxListeners(0);
  }

  /** 이 세션에 주입된 CLAUDE.md 목록. */
  private memoryFiles: MemoryFile[] = [];

  getMemoryFiles(): Array<{ scope: string; path: string }> {
    return this.memoryFiles.map(({ scope, path: p }) => ({ scope, path: p }));
  }

  getPolicyMode(): PolicyMode {
    return this.policyMode;
  }

  setPolicyMode(mode: PolicyMode): void {
    this.policyMode = mode;
  }

  info(): SessionInfo {
    return {
      id: this.id,
      workspaceId: this.workspaceId,
      cwd: this.cwd,
      title: this.title,
      status: this.status,
      claudeSessionId: this.claudeSessionId,
      policyMode: this.policyMode,
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
      turns: this.turns,
      totalCostUsd: this.totalCostUsd,
      pending: [...this.pending.values()].map(({ resolve: _r, ...rest }) => rest),
      memory: this.getMemoryFiles(),
      slashCommands: this.slashCommands,
    };
  }

  private emit(event: Omit<SessionEvent, 'sessionId' | 'at'>): void {
    this.lastActivityAt = new Date().toISOString();
    const full = { ...event, sessionId: this.id, at: this.lastActivityAt } as SessionEvent;
    // 재생 가치가 없는 이벤트는 이력에서 뺀다. status는 소음이 많고,
    // permission_request는 미해결 상태로 남아 재생 시 오해를 부른다.
    if (full.type !== 'status' && full.type !== 'permission_request') {
      history.append(this.id, full);
    }
    this.events.emit('event', full);
    this.syncMeta();
  }

  /** 목록 복원용 요약을 갱신한다. */
  private syncMeta(): void {
    history.writeMeta({
      id: this.id,
      workspaceId: this.workspaceId,
      cwd: this.cwd,
      title: this.title,
      claudeSessionId: this.claudeSessionId,
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
      turns: this.turns,
      totalCostUsd: this.totalCostUsd,
      status: this.status,
    });
  }

  setTitle(title: string): void {
    this.title = title;
    this.syncMeta();
  }

  /** 이어가기로 물려받은 누적값. 헤더의 턴 수·비용이 0으로 돌아가지 않게 한다. */
  carryOver(turns: number, costUsd: number): void {
    this.turns = turns;
    this.totalCostUsd = costUsd;
    this.syncMeta();
  }

  private setStatus(status: SessionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit({ type: 'status', status });
  }

  /** CLI 프로세스를 띄운다. */
  start(): void {
    // 실행 파일 하나로 돌면 자기 자신을 권한 서버로 띄운다(src/bin.ts).
    // tsx로 개발 중이면 .ts를, 빌드본이면 .js를 실행한다.
    const isTs = HERE.includes(`${path.sep}src${path.sep}`) || HERE.endsWith(`${path.sep}src`);
    const permServer = path.join(HERE, isTs ? 'permission-server.ts' : 'permission-server.js');
    const runner = runtime.selfExec
      ? { command: process.execPath, args: ['--permission-server'] }
      : isTs
        ? { command: 'npx', args: ['tsx', permServer] }
        : { command: process.execPath, args: [permServer] };

    const mcpConfig = {
      mcpServers: {
        agentPerm: {
          type: 'stdio',
          command: runner.command,
          args: runner.args,
          env: {
            AGENT_MANAGER_URL: `http://${config.host}:${config.port}`,
            AGENT_SESSION_ID: this.id,
            AGENT_PERM_TOKEN: this.permToken,
          },
        },
      },
    };

    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-prompt-tool',
      'mcp__agentPerm__approve',
      '--mcp-config',
      JSON.stringify(mcpConfig),
      // 사용자 설정의 사전 허용 규칙이 권한 훅을 우회하지 않도록 격리한다.
      '--setting-sources',
      '',
      '--permission-mode',
      this.options.permissionMode ?? 'manual',
    ];
    // 값은 --옵션=값 한 덩어리로 넘긴다. `-`로 시작하는 값이 옵션으로 읽히지 않게. runner.ts 참고.
    if (this.options.model) args.push(`--model=${this.options.model}`);

    // --setting-sources ''로 설정을 격리하므로 CLAUDE.md가 자동 로드되지 않는다.
    // 직접 읽어 시스템 프롬프트로 주입한다.
    const extraPrompt: string[] = [];
    if (this.options.loadMemory !== false) {
      this.memoryFiles = collectMemory(this.cwd);
      const memoryPrompt = buildMemoryPrompt(this.memoryFiles);
      if (memoryPrompt) extraPrompt.push(memoryPrompt);
    }
    if (this.options.appendSystemPrompt) extraPrompt.push(this.options.appendSystemPrompt);
    if (extraPrompt.length > 0) {
      args.push(`--append-system-prompt=${extraPrompt.join('\n\n---\n\n')}`);
    }
    if (this.options.resumeSessionId) args.push(`--resume=${this.options.resumeSessionId}`);

    const child = spawn(config.claudeBin, args, {
      cwd: this.cwd,
      // 매니저·relay 비밀값은 빼고 넘긴다. child-env.ts 참고.
      env: childEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const text = chunk.trim();
      if (text) this.emit({ type: 'stderr', text });
    });

    child.on('error', (err) => {
      this.emit({ type: 'stderr', text: `프로세스 오류: ${err.message}` });
      this.close();
    });
    child.on('close', () => {
      this.closed = true;
      this.setStatus('closed');
      // 대기 중인 권한 요청은 모두 거부 처리해 호출자가 멈추지 않게 한다.
      for (const p of this.pending.values()) {
        p.resolve({ behavior: 'deny', message: '세션이 종료되었습니다.' });
      }
      this.pending.clear();
      this.flushTurnWaiters({ isError: true, result: '세션이 종료되었습니다.' });
      this.emit({ type: 'closed' });
      history.close(this.id);
    });

    this.syncMeta();
    this.setStatus('idle');
  }

  private onStdout(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (line) this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let msg: StreamLine;
    try {
      msg = JSON.parse(line) as StreamLine;
    } catch {
      return;
    }

    if (msg.type === 'system' && msg.subtype === 'init') {
      if (Array.isArray(msg.slash_commands)) {
        this.slashCommands = msg.slash_commands.filter((c): c is string => typeof c === 'string');
      }
      if (msg.session_id) {
        this.claudeSessionId = msg.session_id;
        this.emit({
          type: 'session',
          claudeSessionId: msg.session_id,
          model: msg.model,
          slashCommands: this.slashCommands,
        });
      }
      return;
    }

    if (msg.type === 'assistant' && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === 'text' && block.text) {
          this.emit({ type: 'assistant', text: block.text });
        } else if (block.type === 'thinking' && block.thinking) {
          this.emit({ type: 'thinking', text: block.thinking });
        } else if (block.type === 'tool_use' && block.name) {
          this.emit({ type: 'tool_use', name: block.name, input: block.input });
        }
      }
      return;
    }

    if (msg.type === 'user' && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === 'tool_result') {
          this.emit({ type: 'tool_result', isError: block.is_error === true });
        }
      }
      return;
    }

    if (msg.type === 'result') {
      this.turns += 1;
      if (msg.total_cost_usd) this.totalCostUsd += msg.total_cost_usd;
      if (msg.session_id) this.claudeSessionId = msg.session_id;
      this.setStatus('idle');
      this.emit({
        type: 'turn_complete',
        result: msg.result,
        isError: msg.is_error === true,
        costUsd: msg.total_cost_usd,
      });
      this.flushTurnWaiters({ result: msg.result, isError: msg.is_error === true });
    }
  }

  private flushTurnWaiters(payload: { result?: string; isError: boolean }): void {
    const waiters = this.turnWaiters;
    this.turnWaiters = [];
    for (const w of waiters) w(payload);
  }

  /** 프롬프트를 보낸다. 프로세스는 살아있으므로 대화가 이어진다. */
  send(prompt: string): void {
    if (this.closed || !this.child) throw new Error('세션이 종료되었습니다.');
    // 첫 프롬프트를 세션 제목으로 삼는다.
    if (!this.title) {
      const firstLine = prompt.trim().split('\n')[0] ?? '';
      this.title = firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine;
    }
    this.setStatus('busy');
    this.emit({ type: 'user', text: prompt });
    this.child.stdin.write(
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: prompt }] },
      }) + '\n',
    );
  }

  /** 프롬프트를 보내고 그 턴이 끝날 때까지 기다린다. */
  async sendAndWait(prompt: string): Promise<{ result?: string; isError: boolean }> {
    const done = new Promise<{ result?: string; isError: boolean }>((resolve) => {
      this.turnWaiters.push(resolve);
    });
    this.send(prompt);
    return done;
  }

  /**
   * 권한 서버가 호출한다. 정책상 자동 승인이면 바로 통과시키고,
   * 아니면 사용자 결정까지 기다린다.
   */
  requestPermission(
    toolName: string,
    input: unknown,
  ): Promise<{ behavior: 'allow' | 'deny'; message?: string }> {
    const decision = evaluate(this.policyMode, toolName, input, this.cwd);
    if (decision.autoApprove) {
      this.emit({
        type: 'permission_resolved',
        toolName,
        behavior: 'allow',
        auto: true,
        reason: decision.reason,
      });
      return Promise.resolve({ behavior: 'allow' });
    }

    const id = randomUUID();
    const summary = summarize(toolName, input);
    return new Promise((resolve) => {
      const entry: PendingPermission = {
        id,
        toolName,
        input,
        summary,
        reason: decision.reason,
        at: new Date().toISOString(),
        resolve: (d) => {
          this.pending.delete(id);
          if (this.pending.size === 0 && !this.closed) this.setStatus('busy');
          this.emit({
            type: 'permission_resolved',
            requestId: id,
            toolName,
            behavior: d.behavior,
            auto: false,
          });
          resolve(d);
        },
      };
      this.pending.set(id, entry);
      this.setStatus('waiting');
      this.emit({
        type: 'permission_request',
        requestId: id,
        toolName,
        input,
        summary,
        reason: decision.reason,
      });
    });
  }

  /** 사용자 결정을 반영한다. */
  resolvePermission(requestId: string, behavior: 'allow' | 'deny', message?: string): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    entry.resolve({ behavior, message });
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.child?.stdin.end();
    } catch {
      // 이미 닫혔으면 무시한다.
    }
    this.child?.kill('SIGTERM');
    setTimeout(() => this.child?.kill('SIGKILL'), 5000).unref();
  }

  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.events.on('event', listener);
    return () => this.events.off('event', listener);
  }
}
