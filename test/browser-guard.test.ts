/**
 * 브라우저와 DNS 리바인딩으로 매니저를 부르지 못하는지 검증.
 *
 * 예전에는 요청 오리진을 그대로 허용해, 키가 없으면 사용자가 연 아무
 * 웹페이지나 127.0.0.1:4000으로 세션을 만들고 명령을 돌릴 수 있었다.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AddressInfo } from 'node:net';

// config는 import 시점에 읽는다. 키가 없는 상태를 본다.
process.env.AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guard-'));
process.env.AGENT_API_KEY = '';
process.env.AGENT_CORS_ORIGINS = 'https://ok.example';

const { createServer } = await import('../src/api/server.js');

/** Host를 직접 정해야 해서 fetch 대신 http.request를 쓴다. */
function call(port: number, headers: Record<string, string>, method = 'GET') {
  return new Promise<{ status: number; acao?: string }>((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/workspaces', method, headers },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0, acao: res.headers['access-control-allow-origin'] as string | undefined });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function withServer(fn: (port: number) => Promise<void>) {
  const { app } = createServer();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    await fn((server.address() as AddressInfo).port);
  } finally {
    server.close();
  }
}

test('Origin 없는 호출(relay-link·client)은 받는다', async () => {
  await withServer(async (port) => {
    assert.equal((await call(port, { host: `127.0.0.1:${port}` })).status, 200);
    assert.equal((await call(port, { host: `localhost:${port}` })).status, 200);
  });
});

test('허용 목록에 없는 웹페이지는 거절한다', async () => {
  await withServer(async (port) => {
    const r = await call(port, { host: `127.0.0.1:${port}`, origin: 'https://evil.example' });
    assert.equal(r.status, 403);
    assert.equal(r.acao, undefined, 'CORS 헤더를 주지 않는다');
    const pre = await call(port, { host: `127.0.0.1:${port}`, origin: 'https://evil.example' }, 'OPTIONS');
    assert.equal(pre.status, 403, '사전 요청도 거절한다');
  });
});

test('허용 목록의 오리진은 받는다', async () => {
  await withServer(async (port) => {
    const r = await call(port, { host: `127.0.0.1:${port}`, origin: 'https://ok.example' });
    assert.equal(r.status, 200);
    assert.equal(r.acao, 'https://ok.example');
  });
});

test('키가 없으면 이 기기 주소가 아닌 Host는 거절한다 (DNS 리바인딩)', async () => {
  await withServer(async (port) => {
    assert.equal((await call(port, { host: `attacker.example:${port}` })).status, 403);
    assert.equal((await call(port, { host: `192.168.0.10:${port}` })).status, 403);
    // 앞머리만 127인 이름. 리바인딩이 바로 이런 이름을 쓴다.
    assert.equal((await call(port, { host: `127.evil.example:${port}` })).status, 403);
    assert.equal((await call(port, { host: `127.0.0.1.nip.io:${port}` })).status, 403);
  });
});
