#!/usr/bin/env node
/**
 * 매니저를 다루는 간단한 CLI 클라이언트.
 *   npx tsx src/client.ts ws add my-app ~/develop/my-app
 *   npx tsx src/client.ts run my-app "테스트 추가해줘"
 */
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadEnv } from './util/env.js';

// 서버와 같은 .env를 읽어 키를 매번 export하지 않아도 되게 한다.
loadEnv();

const BASE = process.env.AGENT_URL ?? `http://127.0.0.1:${process.env.PORT ?? 4000}`;
const KEY = process.env.AGENT_API_KEY ?? '';

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (KEY) h['x-api-key'] = KEY;
  return h;
}

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: headers() });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
  }
  return body;
}

/**
 * SSE 스트림을 받아 사람이 읽기 좋게 출력한다.
 * 이어가기에 쓸 수 있도록 세션 ID를 돌려준다.
 */
async function stream(jobId: string): Promise<string | undefined> {
  const res = await fetch(`${BASE}/jobs/${jobId}/stream`, { headers: headers() });
  if (!res.body) throw new Error('스트림을 열 수 없습니다.');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let sessionId: string | undefined;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    // SSE는 빈 줄로 이벤트를 구분한다.
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      const event = JSON.parse(line.slice(6));

      if (event.type === 'session') sessionId = event.sessionId;
      else if (event.type === 'assistant') console.log(event.text);
      else if (event.type === 'tool_use') console.log(`  · ${event.name}`);
      else if (event.type === 'stderr') console.error(`  ! ${event.text}`);
      else if (event.type === 'status') console.log(`[${event.status}]`);
      else if (event.type === 'result') {
        const j = event.job;
        sessionId = j.sessionId ?? sessionId;
        console.log('─'.repeat(50));
        console.log(`상태: ${j.status}`);
        if (j.error) console.log(`오류: ${j.error}`);
        if (j.sessionId) console.log(`세션: ${j.sessionId}`);
        if (j.usage?.costUsd) console.log(`비용: $${j.usage.costUsd.toFixed(4)}`);
      }
    }
  }

  return sessionId;
}

/** 잡 하나를 만들고 끝까지 스트리밍한다. */
async function submit(
  workspaceId: string,
  prompt: string,
  resumeSessionId?: string,
): Promise<string | undefined> {
  const r = await api('/jobs', {
    method: 'POST',
    body: JSON.stringify({
      workspaceId,
      prompt,
      resumeSessionId,
      permissionMode: process.env.AGENT_PERMISSION_MODE,
      model: process.env.AGENT_MODEL,
    }),
  });
  console.log(`잡 ${r.job.id} (${r.job.cwd})`);
  return stream(r.job.id);
}

/**
 * 대화형 모드. 프롬프트를 반복 입력받고 세션을 이어간다.
 * 빈 줄은 무시하고, /new로 세션을 초기화한다.
 */
async function chat(workspaceId: string): Promise<void> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  let sessionId: string | undefined;
  let closed = false;
  rl.on('close', () => {
    closed = true;
  });

  console.log(`워크스페이스: ${workspaceId}`);
  console.log('프롬프트를 입력하세요. /new 새 세션, /exit 종료 (Ctrl+C도 가능)\n');

  // 파이프 입력은 스트림이 먼저 닫히므로 남은 줄을 미리 모아둔다.
  const pending: string[] = [];
  if (!stdin.isTTY) {
    for await (const line of rl) pending.push(line);
  }

  try {
    for (;;) {
      let line: string;
      if (!stdin.isTTY) {
        if (pending.length === 0) break;
        line = pending.shift()!.trim();
      } else {
        if (closed) break;
        line = (await rl.question(sessionId ? '↩ > ' : '> ')).trim();
      }
      if (!line) continue;
      if (line === '/exit' || line === '/quit') break;
      if (line === '/new') {
        sessionId = undefined;
        console.log('새 세션으로 시작합니다.\n');
        continue;
      }

      try {
        sessionId = (await submit(workspaceId, line, sessionId)) ?? sessionId;
      } catch (err) {
        console.error(`오류: ${(err as Error).message}`);
      }
      console.log();
    }
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);

  switch (cmd) {
    case 'ws': {
      const [sub, ...args] = rest;
      if (sub === 'add') {
        const [id, p, ...desc] = args;
        const r = await api('/workspaces', {
          method: 'POST',
          body: JSON.stringify({ id, path: p, description: desc.join(' ') || undefined }),
        });
        console.log(`등록됨: ${r.workspace.id} → ${r.workspace.path}`);
      } else if (sub === 'rm') {
        await api(`/workspaces/${args[0]}`, { method: 'DELETE' });
        console.log(`삭제됨: ${args[0]}`);
      } else {
        const r = await api('/workspaces');
        for (const w of r.workspaces) {
          console.log(`${w.id.padEnd(20)} ${w.path}${w.description ? `  (${w.description})` : ''}`);
        }
      }
      break;
    }

    case 'run': {
      const [workspaceId, ...promptParts] = rest;
      if (!workspaceId) {
        console.error('사용법: run <workspaceId> [프롬프트]');
        process.exit(1);
      }

      let prompt = promptParts.join(' ');
      // 인자가 없으면 파이프 입력을 읽고, 그것도 없으면 대화형으로 넘어간다.
      if (!prompt && !stdin.isTTY) {
        const chunks: Buffer[] = [];
        for await (const c of stdin) chunks.push(c as Buffer);
        prompt = Buffer.concat(chunks).toString('utf8').trim();
      }
      if (!prompt) {
        await chat(workspaceId);
        break;
      }

      await submit(workspaceId, prompt);
      break;
    }

    case 'chat':
      if (!rest[0]) {
        console.error('사용법: chat <workspaceId>');
        process.exit(1);
      }
      await chat(rest[0]);
      break;

    case 'jobs': {
      const r = await api('/jobs?limit=20');
      for (const j of r.jobs) {
        const summary = (j.result ?? j.error ?? '').slice(0, 50).replace(/\n/g, ' ');
        console.log(`${j.status.padEnd(10)} ${j.id.slice(0, 8)} ${j.workspaceId.padEnd(12)} ${summary}`);
      }
      break;
    }

    case 'logs':
      await stream(rest[0]);
      break;

    case 'cancel':
      await api(`/jobs/${rest[0]}/cancel`, { method: 'POST' });
      console.log('취소 요청됨');
      break;

    default:
      console.log(`사용법:
  ws [list]                   워크스페이스 목록
  ws add <id> <경로> [설명]    워크스페이스 등록
  ws rm <id>                  워크스페이스 삭제
  run <id> <프롬프트>          실행하고 스트림 출력
  run <id>                    대화형 모드 (프롬프트 반복 입력)
  chat <id>                   대화형 모드 (세션 이어감)
  jobs                        최근 잡 목록
  logs <jobId>                잡 스트림 다시 보기
  cancel <jobId>              잡 취소

환경변수: AGENT_URL, AGENT_API_KEY, AGENT_MODEL, AGENT_PERMISSION_MODE`);
  }
}

main().catch((err) => {
  console.error(`오류: ${err.message}`);
  process.exit(1);
});
