/**
 * 권한 MCP 서버 전용 경로가 세션 키만 받는지 검증.
 *
 * 예전에는 MCP 설정(명령줄 인자)에 매니저 API 키를 그대로 실었다. 이제는
 * 세션마다 다른 키를 주고, 그 키로는 그 세션의 권한을 묻는 것만 된다.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AddressInfo } from 'node:net';

// config는 import 시점에 읽으므로 먼저 채운다. 실제 data/를 건드리지 않게 한다.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-perm-'));
process.env.AGENT_DATA_DIR = dir;
process.env.AGENT_API_KEY = 'master-key';

const { createServer } = await import('../src/api/server.js');

async function withServer(fn: (base: string, asked: string[]) => Promise<void>) {
  const { app, sessions } = createServer();
  const asked: string[] = [];
  // CLI를 띄우지 않고 세션 자리만 채운다.
  const fake = {
    id: 's1',
    permToken: 'a'.repeat(64),
    requestPermission: async (tool: string) => {
      asked.push(tool);
      return { behavior: 'allow' as const };
    },
  };
  (sessions as unknown as { sessions: Map<string, unknown> }).sessions.set('s1', fake);

  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, asked);
  } finally {
    server.close();
  }
}

const ask = (base: string, headers: Record<string, string>) =>
  fetch(`${base}/internal/permission`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ sessionId: 's1', toolName: 'Bash', input: { command: 'rm x' } }),
  });

test('세션 키가 맞으면 권한을 묻는다', async () => {
  await withServer(async (base, asked) => {
    const res = await ask(base, { 'x-perm-token': 'a'.repeat(64) });
    assert.equal(res.status, 200);
    assert.deepEqual(asked, ['Bash']);
  });
});

test('세션 키가 틀리거나 없으면 거부한다', async () => {
  await withServer(async (base, asked) => {
    assert.equal((await ask(base, { 'x-perm-token': 'b'.repeat(64) })).status, 401);
    assert.equal((await ask(base, {})).status, 401);
    assert.deepEqual(asked, []);
  });
});

test('매니저 API 키로는 대신할 수 없다', async () => {
  await withServer(async (base, asked) => {
    assert.equal((await ask(base, { 'x-api-key': 'master-key' })).status, 401);
    assert.deepEqual(asked, []);
  });
});

test('다른 API는 여전히 매니저 키가 필요하다', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/workspaces`)).status, 401);
    assert.equal((await fetch(`${base}/workspaces`, { headers: { 'x-api-key': 'master-key' } })).status, 200);
  });
});

test('/health는 키 없이 살아 있는지만 알린다', async () => {
  await withServer(async (base) => {
    const open = (await (await fetch(`${base}/health`)).json()) as Record<string, unknown>;
    assert.equal(open.ok, true);
    assert.equal(open.allowedRoots, undefined, '홈 경로가 드러나지 않는다');

    const full = (await (
      await fetch(`${base}/health`, { headers: { 'x-api-key': 'master-key' } })
    ).json()) as Record<string, unknown>;
    assert.ok(Array.isArray(full.allowedRoots), '키를 내면 웹이 쓰는 허용 루트를 준다');
  });
});
