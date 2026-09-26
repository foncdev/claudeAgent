import path from 'node:path';
import os from 'node:os';
import { loadEnv } from '../util/env.js';

// config가 process.env를 읽기 전에 .env를 채운다.
loadEnv();

function parseRoots(raw: string | undefined): string[] {
  if (!raw) return [path.join(os.homedir(), 'develop')];
  return raw
    .split(':')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => path.resolve(expandHome(p)));
}

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  host: process.env.HOST ?? '127.0.0.1',
  /** 이 루트들 하위 경로만 워크스페이스로 등록할 수 있다. */
  allowedRoots: parseRoots(process.env.AGENT_ALLOWED_ROOTS),
  /** 설정 시 모든 요청에 x-api-key 헤더를 요구한다. */
  apiKey: process.env.AGENT_API_KEY ?? '',
  /**
   * 브라우저에서 직접 부를 수 있는 오리진. 쉼표로 여러 개.
   *
   * 기본은 비어 있다. 웹·안경·폰은 relay-service를 거쳐 오고, relay-link와
   * client.ts는 Origin을 싣지 않으므로 여기 적을 일이 없다. 예전에는 어느
   * 오리진이든 받아줘서, 키가 없을 때 아무 웹페이지나 이 매니저로 세션을
   * 만들고 명령을 돌릴 수 있었다.
   */
  corsOrigins: (process.env.AGENT_CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  claudeBin: process.env.CLAUDE_BIN ?? 'claude',
  dataDir: path.resolve(expandHome(process.env.AGENT_DATA_DIR ?? './data')),
  defaultTimeoutMs: Number(process.env.AGENT_TIMEOUT_MS ?? 30 * 60 * 1000),
  maxConcurrent: Number(process.env.AGENT_MAX_CONCURRENT ?? 3),
  /** 메모리에 보관할 최근 잡 개수. */
  jobHistoryLimit: Number(process.env.AGENT_JOB_HISTORY ?? 200),

  /**
   * relay-service 접속 주소. 설정하면 그쪽으로 나가서 붙는다.
   * 예: ws://127.0.0.1:4100/agent
   */
  relayUrl: process.env.RELAY_URL ?? '',
  relayToken: process.env.RELAY_AGENT_TOKEN ?? '',
  /** relay-service 목록에 표시될 이름. */
  relayName: process.env.RELAY_AGENT_NAME ?? os.hostname(),
} as const;

/** 이 기기 안에서만 닿는 주소인지. */
export function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || h.startsWith('127.');
}
