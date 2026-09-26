import { Session, type SessionInfo } from './session.js';
import { assertChecked, type PolicyMode } from './policy.js';
import { config } from './config.js';
import type { WorkspaceRegistry } from './workspaces.js';
import { history } from './history.js';

export class SessionError extends Error {
  constructor(message: string, readonly code = 'session_error') {
    super(message);
  }
}

export interface CreateSessionInput {
  workspaceId?: string;
  /** 절대 경로. 주면 워크스페이스를 자동으로 찾거나 만든다. */
  path?: string;
  subPath?: string;
  model?: string;
  policyMode?: PolicyMode;
  permissionMode?: string;
  appendSystemPrompt?: string;
  resumeSessionId?: string;
  /** false면 CLAUDE.md를 주입하지 않는다. */
  loadMemory?: boolean;
}

/** 살아있는 세션들을 보관한다. */
export class SessionRegistry {
  private sessions = new Map<string, Session>();

  constructor(private readonly workspaces: WorkspaceRegistry) {}

  create(input: CreateSessionInput): Session {
    // 이어가기도 여기를 지나므로 한 곳에서 막으면 된다.
    assertChecked(input, config.allowUnchecked);
    // 경로를 직접 준 경우를 우선한다. 없으면 등록된 워크스페이스를 쓴다.
    const ws = input.path
      ? this.workspaces.findOrCreateByPath(input.path)
      : this.workspaces.require(input.workspaceId ?? '');
    const cwd = this.workspaces.resolveCwd(ws, input.subPath);

    const session = new Session(ws.id, cwd, input.policyMode ?? 'ask-risky', {
      model: input.model,
      permissionMode: input.permissionMode,
      appendSystemPrompt: input.appendSystemPrompt,
      resumeSessionId: input.resumeSessionId,
      loadMemory: input.loadMemory,
    });

    this.sessions.set(session.id, session);
    // 종료된 세션은 목록에서 치운다.
    session.events.on('event', (e) => {
      if (e.type === 'closed') {
        setTimeout(() => this.sessions.delete(session.id), 60_000).unref();
      }
    });
    session.start();
    return session;
  }

  /**
   * 종료된 세션의 대화를 이어간다.
   *
   * Claude CLI의 --resume에 저장해둔 claudeSessionId를 넘겨 새 프로세스를 띄운다.
   * 매니저 세션 id는 새로 생기지만, CLI 쪽 대화 맥락은 그대로 이어진다.
   */
  resume(
    sessionId: string,
    overrides: Partial<CreateSessionInput> & { deleteOriginal?: boolean } = {},
  ): Session {
    // 이미 살아있으면 그대로 쓴다.
    const alive = this.sessions.get(sessionId);
    if (alive && alive.info().status !== 'closed') return alive;

    const meta = history.readMeta(sessionId);
    if (!meta) {
      throw new SessionError(`기록이 없는 세션입니다: ${sessionId}`, 'session_not_found');
    }
    if (!meta.claudeSessionId) {
      throw new SessionError(
        '이어갈 대화가 없습니다. 한 번도 프롬프트를 주고받지 않은 세션입니다.',
        'nothing_to_resume',
      );
    }

    const { deleteOriginal, ...createOverrides } = overrides;
    const session = this.create({
      workspaceId: meta.workspaceId,
      ...createOverrides,
      resumeSessionId: meta.claudeSessionId,
    });

    // 이전 대화를 새 세션 기록에 물려준다.
    // 이게 없으면 CLI는 맥락을 기억하는데 화면만 빈 채로 시작한다.
    history.inherit(sessionId, session.id);
    // 턴 수와 비용도 이어받는다. 대화는 이어지는데 0턴으로 보이면 어긋난다.
    session.carryOver(meta.turns ?? 0, meta.totalCostUsd ?? 0);
    // 어느 대화를 이어받았는지 목록에서 알아보게 제목을 물려준다.
    if (meta.title) session.setTitle(meta.title);

    // 새 세션이 무사히 만들어진 뒤에만 원본을 지운다.
    // 여기서 실패해도 이어가기 자체는 성공이므로 예외를 밖으로 던지지 않는다.
    if (deleteOriginal) {
      this.sessions.delete(sessionId);
      history.remove(sessionId);
    }
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => s.info());
  }

  close(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.close();
    return true;
  }

  closeAll(): void {
    for (const s of this.sessions.values()) s.close();
  }
}
