#!/usr/bin/env node
/**
 * 대화형 클라이언트. CLI와 비슷한 흐름을 제공한다.
 *
 *   프롬프트 입력 → 진행 → 권한 요청이 오면 선택 → 이어서 진행
 */
import readline from 'node:readline';
import { stdin, stdout } from 'node:process';
import { loadEnv } from './util/env.js';

loadEnv();

const BASE = process.env.AGENT_URL ?? `http://127.0.0.1:${process.env.PORT ?? 4000}`;
const KEY = process.env.AGENT_API_KEY ?? '';

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (KEY) h['x-api-key'] = KEY;
  return h;
}

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: headers() });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
  return body;
}

/** 권한 요청을 화면에 띄우고 사용자 선택을 받는다. */
async function askPermission(
  rl: readline.Interface,
  sessionId: string,
  ev: any,
): Promise<void> {
  console.log();
  console.log(C.yellow('┌─ 권한 요청'));
  console.log(C.yellow('│ ') + C.bold(ev.toolName) + C.dim(`  (${ev.reason})`));
  for (const line of String(ev.summary ?? '').split('\n').slice(0, 6)) {
    console.log(C.yellow('│ ') + line);
  }
  console.log(C.yellow('└─ ') + C.dim('1) 허용  2) 거부  3) 이번 세션 전체 허용'));

  const choice = await new Promise<string>((resolve) => {
    rl.question('선택 [1] > ', (a) => resolve(a.trim() || '1'));
  });

  if (choice === '3') {
    await api(`/sessions/${sessionId}/policy`, {
      method: 'POST',
      body: JSON.stringify({ policyMode: 'auto-approve' }),
    });
    console.log(C.dim('  이후 자동 승인으로 전환합니다.'));
  }

  const behavior = choice === '2' ? 'deny' : 'allow';
  await api(`/sessions/${sessionId}/permissions`, {
    method: 'POST',
    body: JSON.stringify({
      requestId: ev.requestId,
      behavior,
      message: behavior === 'deny' ? '사용자가 거부했습니다.' : undefined,
    }),
  });
  console.log(behavior === 'allow' ? C.green('  → 허용') : C.red('  → 거부'));
  console.log();
}

/** 서버 이벤트를 받아 화면에 출력한다. 턴이 끝나면 알린다. */
function connectStream(
  sessionId: string,
  rl: readline.Interface,
  onIdle: () => void,
): { close: () => void } {
  const controller = new AbortController();

  void (async () => {
    const res = await fetch(`${BASE}/sessions/${sessionId}/stream`, {
      headers: headers(),
      signal: controller.signal,
    });
    if (!res.body) return;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    // 권한 질문이 겹치지 않도록 순차 처리한다.
    let chain: Promise<void> = Promise.resolve();

    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch {
        break;
      }
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });

      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const dataLine = raw.split('\n').find((l) => l.startsWith('data: '));
        if (!dataLine) continue;

        let ev: any;
        try {
          ev = JSON.parse(dataLine.slice(6));
        } catch {
          continue;
        }

        switch (ev.type) {
          case 'assistant':
            console.log(ev.text);
            break;
          case 'tool_use':
            console.log(C.dim(`  · ${ev.name}`));
            break;
          case 'permission_request':
            chain = chain.then(() => askPermission(rl, sessionId, ev));
            break;
          case 'permission_resolved':
            if (ev.auto) console.log(C.dim(`  · ${ev.toolName} 자동 승인 (${ev.reason})`));
            break;
          case 'turn_complete':
            if (ev.costUsd) console.log(C.dim(`  [완료 · $${Number(ev.costUsd).toFixed(4)}]`));
            chain = chain.then(() => {
              onIdle();
            });
            break;
          case 'stderr':
            console.error(C.red(`  ! ${ev.text}`));
            break;
          case 'closed':
            console.log(C.dim('세션이 종료되었습니다.'));
            break;
        }
      }
    }
  })().catch(() => {
    // 종료 시 abort는 정상 흐름이므로 무시한다.
  });

  return { close: () => controller.abort() };
}

async function main(): Promise<void> {
  const workspaceId = process.argv[2];
  if (!workspaceId) {
    console.error('사용법: npx tsx src/repl.ts <workspaceId>');
    process.exit(1);
  }

  const created = await api('/sessions', {
    method: 'POST',
    body: JSON.stringify({
      workspaceId,
      model: process.env.AGENT_MODEL,
      policyMode: process.env.AGENT_POLICY_MODE,
    }),
  });
  const session = created.session;

  console.log(C.cyan(`세션 ${session.id.slice(0, 8)} · ${session.cwd}`));
  for (const m of session.memory ?? []) {
    console.log(C.dim(`  CLAUDE.md · ${m.path}`));
  }
  console.log(C.dim('프롬프트를 입력하세요. /exit 종료, /policy <모드> 권한 정책 변경\n'));

  const rl = readline.createInterface({ input: stdin, output: stdout });
  const stream = connectStream(session.id, rl, () => prompt());

  let busy = false;
  function prompt(): void {
    busy = false;
    rl.setPrompt('> ');
    rl.prompt();
  }

  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) {
      if (!busy) rl.prompt();
      return;
    }
    // 권한 질문에 답하는 중이면 rl.question이 가로채므로 여기 오지 않는다.
    if (busy) return;

    if (text === '/exit' || text === '/quit') {
      rl.close();
      return;
    }
    if (text.startsWith('/policy ')) {
      const mode = text.slice(8).trim();
      void api(`/sessions/${session.id}/policy`, {
        method: 'POST',
        body: JSON.stringify({ policyMode: mode }),
      })
        .then(() => console.log(C.dim(`권한 정책: ${mode}`)))
        .catch((e) => console.error(C.red(e.message)))
        .finally(() => rl.prompt());
      return;
    }

    busy = true;
    void api(`/sessions/${session.id}/input`, {
      method: 'POST',
      body: JSON.stringify({ prompt: text }),
    }).catch((e) => {
      console.error(C.red(e.message));
      prompt();
    });
  });

  rl.on('close', () => {
    stream.close();
    void api(`/sessions/${session.id}`, { method: 'DELETE' }).finally(() => process.exit(0));
  });

  prompt();
}

main().catch((err) => {
  console.error(`오류: ${err.message}`);
  process.exit(1);
});
