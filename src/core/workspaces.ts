import fs from 'node:fs';
import path from 'node:path';
import { config, expandHome } from './config.js';
import type { Workspace } from './types.js';

const STORE = path.join(config.dataDir, 'workspaces.json');

export class WorkspaceError extends Error {
  constructor(message: string, readonly code = 'workspace_error') {
    super(message);
  }
}

/** child가 parent와 같거나 그 하위인지 검사한다. 경계 오탐(/a/bc vs /a/b)을 막는다. */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 경로를 심볼릭 링크까지 풀어서 정규화한다.
 * 링크를 통한 허용 루트 탈출을 막기 위해 realpath를 쓴다.
 */
function canonicalize(p: string): string {
  const abs = path.resolve(expandHome(p));
  try {
    return fs.realpathSync(abs);
  } catch {
    throw new WorkspaceError(`경로가 존재하지 않습니다: ${abs}`, 'path_not_found');
  }
}

/** 허용 루트 하위인지 확인하고, 정규화된 절대 경로를 돌려준다. */
export function assertAllowedPath(p: string): string {
  const real = canonicalize(p);
  const stat = fs.statSync(real);
  if (!stat.isDirectory()) {
    throw new WorkspaceError(`디렉토리가 아닙니다: ${real}`, 'not_a_directory');
  }
  const roots = config.allowedRoots.map((r) => {
    try {
      return fs.realpathSync(r);
    } catch {
      return path.resolve(r);
    }
  });
  if (!roots.some((root) => isInside(root, real))) {
    throw new WorkspaceError(
      `허용된 루트 밖의 경로입니다: ${real} (허용: ${roots.join(', ')})`,
      'path_not_allowed',
    );
  }
  return real;
}

export class WorkspaceRegistry {
  private items = new Map<string, Workspace>();

  constructor() {
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(STORE)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(STORE, 'utf8')) as Workspace[];
      for (const w of raw) this.items.set(w.id, w);
    } catch {
      // 손상된 저장 파일은 무시하고 빈 레지스트리로 시작한다.
    }
  }

  private persist(): void {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(STORE, JSON.stringify([...this.items.values()], null, 2));
  }

  list(): Workspace[] {
    return [...this.items.values()];
  }

  get(id: string): Workspace | undefined {
    return this.items.get(id);
  }

  /** 등록되어 있고 지금도 유효한 워크스페이스를 돌려준다. */
  require(id: string): Workspace {
    const w = this.items.get(id);
    if (!w) throw new WorkspaceError(`등록되지 않은 워크스페이스: ${id}`, 'workspace_not_found');
    // 등록 이후 경로가 삭제/이동됐을 수 있으므로 사용 시점에 다시 검증한다.
    assertAllowedPath(w.path);
    return w;
  }

  register(input: { id: string; path: string; description?: string }): Workspace {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(input.id)) {
      throw new WorkspaceError(
        'id는 영문/숫자/밑줄/하이픈 1~64자여야 합니다.',
        'invalid_workspace_id',
      );
    }
    if (this.items.has(input.id)) {
      throw new WorkspaceError(`이미 존재하는 워크스페이스: ${input.id}`, 'workspace_exists');
    }
    const real = assertAllowedPath(input.path);
    const ws: Workspace = {
      id: input.id,
      path: real,
      description: input.description,
      createdAt: new Date().toISOString(),
    };
    this.items.set(ws.id, ws);
    this.persist();
    return ws;
  }

  remove(id: string): boolean {
    const ok = this.items.delete(id);
    if (ok) this.persist();
    return ok;
  }

  /**
   * 절대 경로로 워크스페이스를 찾고, 없으면 새로 등록한다.
   * 경로를 바로 입력해 세션을 여는 흐름에서 쓴다.
   * 허용 루트 검사는 register/assertAllowedPath가 그대로 수행한다.
   */
  findOrCreateByPath(rawPath: string): Workspace {
    const real = assertAllowedPath(rawPath);
    const existing = this.list().find((w) => w.path === real);
    if (existing) return existing;

    // 디렉토리 이름을 id로 삼되, 충돌하면 뒤에 숫자를 붙인다.
    // id는 영숫자만 허용되므로 한글 등은 남지 않는다. 전부 걸러지면 'ws'로 대체한다.
    const cleaned = path
      .basename(real)
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);
    const base = cleaned || 'ws';
    let id = base;
    for (let n = 2; this.items.has(id); n += 1) id = `${base}-${n}`;

    return this.register({ id, path: real, description: '경로로 자동 등록됨' });
  }

  /**
   * 워크스페이스 내부의 하위 경로를 해석한다.
   * 워크스페이스 밖으로 나가는 상대 경로는 거부한다.
   */
  resolveCwd(ws: Workspace, subPath?: string): string {
    if (!subPath) return ws.path;
    if (path.isAbsolute(subPath)) {
      throw new WorkspaceError('subPath는 상대 경로여야 합니다.', 'invalid_sub_path');
    }
    const target = canonicalize(path.join(ws.path, subPath));
    if (!isInside(ws.path, target)) {
      throw new WorkspaceError(
        `subPath가 워크스페이스를 벗어납니다: ${subPath}`,
        'sub_path_escape',
      );
    }
    return target;
  }
}
