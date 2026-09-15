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
