/**
 * Claude CLI에 매니저·relay 비밀값이 넘어가지 않는지 검증.
 *
 * 넘어가면 Claude가 `echo $AGENT_API_KEY`(자동 승인되는 명령)로 매니저
 * 키를 얻어 자기 권한을 스스로 풀 수 있다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { childEnv } from '../src/core/child-env.js';

test('AGENT_·RELAY_ 변수는 빼고 나머지는 넘긴다', () => {
  const saved = { ...process.env };
  try {
    process.env.AGENT_API_KEY = 'secret';
    process.env.RELAY_AGENT_TOKEN = 'secret';
    process.env.RELAY_URL = 'ws://x';
    process.env.ANTHROPIC_API_KEY = 'keep';
    process.env.PATH = '/usr/bin';

    const env = childEnv({ EXTRA: '1' });
    assert.equal(env.AGENT_API_KEY, undefined);
    assert.equal(env.RELAY_AGENT_TOKEN, undefined);
    assert.equal(env.RELAY_URL, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, 'keep', 'CLI 자신의 설정은 남긴다');
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.CLAUDE_CODE_ENTRYPOINT, 'agent-cli-manager');
    assert.equal(env.EXTRA, '1');
  } finally {
    process.env = saved;
  }
});
