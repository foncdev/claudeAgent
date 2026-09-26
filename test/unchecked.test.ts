/**
 * 권한 확인 없는 실행과 CLI 옵션 인젝션을 막는지 검증.
 *
 * relay가 /sessions·/jobs를 중계하므로, 요청 값으로 bypassPermissions나
 * allowedTools를 받아주면 폰·안경 로그인 토큰 하나로 밖에서 확인 없는
 * 실행이 됐다. 또 -p 뒤에 둔 프롬프트가 `-`로 시작하면 CLI가 옵션으로
 * 읽었다. 실제 CLI(2.1.283)로 "--version" 프롬프트가 버전을 찍는 것을 봤다.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AddressInfo } from 'node:net';

process.env.AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-unchecked-'));
process.env.AGENT_API_KEY = 'k';
delete process.env.AGENT_ALLOW_UNCHECKED;

const { assertChecked, PolicyError } = await import('../src/core/policy.js');
const { buildArgs } = await import('../src/core/runner.js');
const { createJobSchema, createSessionSchema } = await import('../src/api/schemas.js');
const { createServer } = await import('../src/api/server.js');

test('확인을 건너뛰는 모드와 allowedTools는 서버 설정 없이 거절한다', () => {
  assert.throws(() => assertChecked({ permissionMode: 'bypassPermissions' }, false), PolicyError);
  assert.throws(() => assertChecked({ permissionMode: 'auto' }, false), PolicyError);
  assert.throws(() => assertChecked({ allowedTools: ['Bash'] }, false), PolicyError);
});

test('확인을 거치는 모드는 받는다', () => {
  for (const m of [undefined, 'manual', 'default', 'acceptEdits', 'plan', 'dontAsk']) {
    assert.doesNotThrow(() => assertChecked({ permissionMode: m, allowedTools: [] }, false), String(m));
  }
});

test('서버 설정으로 켜면 받는다', () => {
  assert.doesNotThrow(() => assertChecked({ permissionMode: 'bypassPermissions', allowedTools: ['Bash'] }, true));
});

test('프롬프트는 -- 뒤 맨 끝에 두고, 값은 --옵션=값으로 넘긴다', () => {
  const args = buildArgs({
    workspaceId: 'w',
    prompt: '--dangerously-skip-permissions',
    model: 'haiku',
    appendSystemPrompt: '--version',
    permissionMode: 'plan',
  });
  assert.deepEqual(args.slice(-2), ['--', '--dangerously-skip-permissions']);
  assert.ok(args.includes('--model=haiku'));
  assert.ok(args.includes('--append-system-prompt=--version'), '값이 따로 떨어져 옵션으로 읽히지 않는다');
  assert.ok(!args.includes('--version'));
});

test('옵션처럼 보이는 도구 이름과 모델 이름은 받지 않는다', () => {
  const base = { workspaceId: 'w', prompt: 'hi' };
  assert.equal(createJobSchema.safeParse({ ...base, allowedTools: ['--version'] }).success, false);
  assert.equal(createJobSchema.safeParse({ ...base, disallowedTools: ['-x'] }).success, false);
  assert.equal(createJobSchema.safeParse({ ...base, model: '--help' }).success, false);
  assert.equal(createSessionSchema.safeParse({ path: '/x', model: '-v' }).success, false);
  assert.equal(createJobSchema.safeParse({ ...base, allowedTools: ['Bash(git log:*)'], model: 'claude-sonnet-5' }).success, true);
});

test('API로 확인 없는 실행을 요청하면 403', async () => {
  const { app } = createServer();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (p: string, body: unknown) =>
    fetch(`${base}${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
      body: JSON.stringify(body),
    });
  try {
    const s = await post('/sessions', { path: '/tmp', permissionMode: 'bypassPermissions' });
    assert.equal(s.status, 403);
    const j = await post('/jobs', { workspaceId: 'w', prompt: 'hi', allowedTools: ['Bash'] });
    assert.equal(j.status, 403);
    const b = (await j.json()) as { error: { code: string } };
    assert.equal(b.error.code, 'unchecked_disabled');
  } finally {
    server.close();
  }
});
