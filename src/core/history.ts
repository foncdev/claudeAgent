import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import type { SessionEvent } from './session.js';

const DIR = path.join(config.dataDir, 'sessions');

/** 파일명에 쓸 수 없는 문자를 막는다. 세션 id는 UUID지만 방어적으로 검사한다. */
function safeId(id: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error(`잘못된 세션 id: ${id}`);
  return id;
}

function logPath(sessionId: string): string {
  return path.join(DIR, `${safeId(sessionId)}.jsonl`);
}

function metaPath(sessionId: string): string {
  return path.join(DIR, `${safeId(sessionId)}.meta.json`);
}

/** 새로고침 후에도 세션 목록을 복원하기 위한 요약 정보. */
export interface SessionMeta {
  id: string;
  workspaceId: string;
  cwd: string;
  title?: string;
  claudeSessionId?: string;
  createdAt: string;
  lastActivityAt: string;
  turns: number;
  totalCostUsd: number;
  /** 프로세스가 살아있는지와 무관하게, 마지막으로 관측된 상태. */
  status: string;
}

/**
 * 세션 대화 이력을 파일에 남긴다.
 *
 * 이벤트를 JSONL로 append하고, 요약은 별도 meta 파일에 덮어쓴다.
 * 스트림 이벤트가 곧 이력이므로 별도 변환 없이 그대로 기록한다.
 */
export class HistoryStore {
  /** 세션별 append 스트림. 이벤트마다 파일을 여닫지 않기 위해 캐시한다. */
  private streams = new Map<string, fs.WriteStream>();

  constructor() {
    fs.mkdirSync(DIR, { recursive: true });
  }

  private stream(sessionId: string): fs.WriteStream {
    let s = this.streams.get(sessionId);
    if (!s) {
      s = fs.createWriteStream(logPath(sessionId), { flags: 'a' });
      // 스트림 오류로 프로세스가 죽지 않게 한다. 이력은 부가 기능이다.
      s.on('error', () => this.streams.delete(sessionId));
      this.streams.set(sessionId, s);
    }
    return s;
  }

  /** 이벤트 한 건을 기록한다. 사용자 프롬프트도 같은 형식으로 넣는다. */
  append(sessionId: string, event: Record<string, unknown>): void {
    try {
      this.stream(sessionId).write(JSON.stringify(event) + '\n');
    } catch {
      // 기록 실패가 세션 진행을 막지 않게 한다.
    }
  }

  writeMeta(meta: SessionMeta): void {
    try {
      fs.writeFileSync(metaPath(meta.id), JSON.stringify(meta, null, 2));
    } catch {
      // 무시한다.
    }
  }

  readMeta(sessionId: string): SessionMeta | undefined {
    try {
      return JSON.parse(fs.readFileSync(metaPath(sessionId), 'utf8')) as SessionMeta;
    } catch {
      return undefined;
    }
  }

  /** 저장된 모든 세션 요약을 최근 활동 순으로 돌려준다. */
  listMeta(): SessionMeta[] {
    let names: string[];
    try {
      names = fs.readdirSync(DIR);
    } catch {
      return [];
    }
    const out: SessionMeta[] = [];
    for (const name of names) {
      if (!name.endsWith('.meta.json')) continue;
      const meta = this.readMeta(name.slice(0, -'.meta.json'.length));
      if (meta) out.push(meta);
    }
    return out.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  }

  /**
   * 기록된 이벤트를 읽는다.
   * limit을 주면 뒤에서부터(최신) 그만큼만 남긴다.
   */
  read(sessionId: string, limit?: number): Array<Record<string, unknown>> {
    let raw: string;
    try {
      raw = fs.readFileSync(logPath(sessionId), 'utf8');
    } catch {
      return [];
    }
    const events: Array<Record<string, unknown>> = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // 쓰다 만 마지막 줄일 수 있다. 건너뛴다.
      }
    }
    return limit && events.length > limit ? events.slice(-limit) : events;
  }

  /**
   * 이어가기한 세션이 이전 대화를 그대로 보여주도록 기록을 물려준다.
   *
   * CLI는 --resume으로 맥락을 이어받지만 매니저의 화면용 기록은 새 파일이라 비어 있다.
   * 그대로 두면 "이어가기를 했는데 이전 대화가 안 보인다"가 된다.
   *
   * 이어받은 줄에는 fromSessionId를 남겨, 새로 생긴 이벤트와 구분할 수 있게 한다.
   */
  inherit(fromSessionId: string, toSessionId: string): number {
    const events = this.read(fromSessionId);
    if (events.length === 0) return 0;

    // 재생 시 혼란을 주는 이벤트는 물려주지 않는다.
    // closed는 새 세션이 죽은 것처럼 보이게 하고, 지난 권한 요청은 응답할 수 없다.
    const carried = events.filter(
      (e) => e.type !== 'closed' && e.type !== 'permission_request',
    );
    if (carried.length === 0) return 0;

    const lines = carried
      .map((e) => JSON.stringify({ ...e, sessionId: toSessionId, fromSessionId }))
      .join('\n');

    try {
      // 새 세션이 첫 이벤트를 쓰기 전에 넣어야 순서가 어긋나지 않는다.
      fs.appendFileSync(logPath(toSessionId), `${lines}\n`);
      // 경계를 표시해 어디까지가 이전 대화인지 보이게 한다.
      this.append(toSessionId, {
        type: 'resumed',
        sessionId: toSessionId,
        fromSessionId,
        at: new Date().toISOString(),
        carried: carried.length,
      });
    } catch {
      // 물려주기 실패가 이어가기 자체를 막지는 않는다.
      return 0;
    }
    return carried.length;
  }

  /** 세션 이력과 요약을 함께 지운다. */
  remove(sessionId: string): boolean {
    this.close(sessionId);
    let removed = false;
    for (const p of [logPath(sessionId), metaPath(sessionId)]) {
      try {
        fs.unlinkSync(p);
        removed = true;
      } catch {
        // 없으면 넘어간다.
      }
    }
    return removed;
  }

  close(sessionId: string): void {
    const s = this.streams.get(sessionId);
    if (!s) return;
    this.streams.delete(sessionId);
    s.end();
  }

  closeAll(): void {
    for (const id of [...this.streams.keys()]) this.close(id);
  }
}

export const history = new HistoryStore();
