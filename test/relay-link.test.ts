/**
 * relay가 보낸 경로를 거르는지 검증.
 *
 * relay-service는 /sessions·/workspaces·/jobs·/files·/health만 중계한다.
 * 그런데 `/sessions/../internal/permission`처럼 ..을 끼우면 relay의 앞머리
 * 검사는 지나고, 이쪽 fetch가 정규화하면서 다른 경로가 됐다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { RelayLink } from '../src/core/relay-link.js';

const link = new RelayLink('ws://127.0.0.1:1/agent', 't', 'test') as unknown as {
  localUrl(p: string): string | null;
};

test('중계하는 경로는 이 매니저 주소로 바꾼다', () => {
  for (const p of ['/sessions', '/sessions/abc/stream?apiKey=x', '/workspaces/w/file?path=a', '/jobs', '/health']) {
    assert.ok(link.localUrl(p)?.startsWith('http://127.0.0.1:'), p);
  }
});

test('중계하지 않는 경로와 ..으로 빠져나가는 경로는 거른다', () => {
  for (const p of [
    '/internal/permission',
    '/sessions/../internal/permission',
    '/sessions/%2e%2e/internal/permission',
    '/health/../internal/permission',
    '/',
    '/sessionsX',
    '//evil.example/sessions',
    'http://evil.example/sessions',
  ]) {
    assert.equal(link.localUrl(p), null, p);
  }
});
