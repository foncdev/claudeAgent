import fs from 'node:fs';
import path from 'node:path';
import type { Workspace } from './types.js';
import { WorkspaceError } from './workspaces.js';

/** 텍스트로 돌려줄 파일의 최대 크기. 그 이상은 거부하고 다운로드를 쓰게 한다. */
const MAX_READ_BYTES = 2 * 1024 * 1024;

export interface FileEntry {
  name: string;
  /** 워크스페이스 루트 기준 상대 경로. */
  path: string;
  type: 'file' | 'dir';
  size: number;
  modifiedAt: string;
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 워크스페이스 기준 상대 경로를 절대 경로로 바꾼다.
 *
 * 존재하지 않는 파일도 허용해야 하므로(새 파일 생성) realpath를 쓸 수 없다.
 * 대신 경로를 정규화한 뒤 부모 디렉토리의 realpath로 심볼릭 링크 탈출을 막는다.
 */
export function resolveInWorkspace(ws: Workspace, relPath: string): string {
  if (path.isAbsolute(relPath)) {
    throw new WorkspaceError('경로는 워크스페이스 기준 상대 경로여야 합니다.', 'invalid_path');
  }
  const target = path.resolve(ws.path, relPath);
  if (!isInside(ws.path, target)) {
    throw new WorkspaceError(`워크스페이스를 벗어나는 경로: ${relPath}`, 'path_escape');
  }

  // 이미 존재하면 자기 자신을, 아니면 가장 가까운 상위 디렉토리를 풀어서 검사한다.
  let probe = target;
  for (;;) {
    try {
      const real = fs.realpathSync(probe);
      const rootReal = fs.realpathSync(ws.path);
      // probe가 링크였다면 그 뒤에 붙은 나머지 구간을 다시 이어 붙인다.
      const suffix = path.relative(probe, target);
      const resolved = suffix ? path.join(real, suffix) : real;
      if (!isInside(rootReal, resolved)) {
        throw new WorkspaceError(`워크스페이스를 벗어나는 경로: ${relPath}`, 'path_escape');
      }
      return target;
    } catch (err) {
      if (err instanceof WorkspaceError) throw err;
      const parent = path.dirname(probe);
      if (parent === probe) {
        throw new WorkspaceError(`경로를 확인할 수 없습니다: ${relPath}`, 'path_not_found');
      }
      probe = parent;
    }
  }
}

/** 목록에서 항상 빼는 디렉토리. 용량이 크고 볼 일이 거의 없다. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '.venv']);

export function list(ws: Workspace, relPath = '', showHidden = false): FileEntry[] {
  const dir = resolveInWorkspace(ws, relPath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch {
    throw new WorkspaceError(`경로가 없습니다: ${relPath || '/'}`, 'path_not_found');
  }
  if (!stat.isDirectory()) {
    throw new WorkspaceError(`디렉토리가 아닙니다: ${relPath}`, 'not_a_directory');
  }

  const entries: FileEntry[] = [];
  for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!showHidden && dirent.name.startsWith('.')) continue;
    if (dirent.isDirectory() && SKIP_DIRS.has(dirent.name)) continue;

    const abs = path.join(dir, dirent.name);
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      // 깨진 심볼릭 링크 등은 건너뛴다.
      continue;
    }
    entries.push({
      name: dirent.name,
      path: path.relative(ws.path, abs),
      type: st.isDirectory() ? 'dir' : 'file',
      size: st.size,
      modifiedAt: st.mtime.toISOString(),
    });
  }

  // 디렉토리 먼저, 그 안에서 이름순.
  return entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** 내용에 NUL이 있으면 바이너리로 본다. 텍스트 에디터에 넘기지 않기 위한 판정. */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) return true;
  return false;
}

export function read(
  ws: Workspace,
  relPath: string,
): { path: string; content: string; size: number; modifiedAt: string } {
  const abs = resolveInWorkspace(ws, relPath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new WorkspaceError(`파일이 없습니다: ${relPath}`, 'file_not_found');
  }
  if (stat.isDirectory()) {
    throw new WorkspaceError(`파일이 아닙니다: ${relPath}`, 'not_a_file');
  }
  if (stat.size > MAX_READ_BYTES) {
    throw new WorkspaceError(
      `파일이 너무 큽니다 (${stat.size} bytes, 최대 ${MAX_READ_BYTES}).`,
      'file_too_large',
    );
  }
  const buf = fs.readFileSync(abs);
  if (looksBinary(buf)) {
    throw new WorkspaceError(`바이너리 파일은 읽을 수 없습니다: ${relPath}`, 'binary_file');
  }
  return {
    path: relPath,
    content: buf.toString('utf8'),
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  };
}

export function write(
  ws: Workspace,
  relPath: string,
  content: string,
): { path: string; size: number; modifiedAt: string } {
  const abs = resolveInWorkspace(ws, relPath);
  try {
    if (fs.statSync(abs).isDirectory()) {
      throw new WorkspaceError(`디렉토리에는 쓸 수 없습니다: ${relPath}`, 'not_a_file');
    }
  } catch (err) {
    if (err instanceof WorkspaceError) throw err;
    // 없는 파일이면 새로 만든다.
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  const stat = fs.statSync(abs);
  return { path: relPath, size: stat.size, modifiedAt: stat.mtime.toISOString() };
}

export function mkdir(ws: Workspace, relPath: string): { path: string } {
  const abs = resolveInWorkspace(ws, relPath);
  fs.mkdirSync(abs, { recursive: true });
  return { path: relPath };
}

export function remove(ws: Workspace, relPath: string, recursive = false): void {
  if (!relPath || relPath === '.' || relPath === '/') {
    throw new WorkspaceError('워크스페이스 루트는 삭제할 수 없습니다.', 'cannot_delete_root');
  }
  const abs = resolveInWorkspace(ws, relPath);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(abs);
  } catch {
    throw new WorkspaceError(`경로가 없습니다: ${relPath}`, 'path_not_found');
  }
  if (stat.isDirectory() && !recursive) {
    const left = fs.readdirSync(abs);
    if (left.length > 0) {
      throw new WorkspaceError(
        `비어 있지 않은 디렉토리입니다. recursive=true가 필요합니다: ${relPath}`,
        'dir_not_empty',
      );
    }
  }
  fs.rmSync(abs, { recursive, force: false });
}

export function rename(ws: Workspace, from: string, to: string): { path: string } {
  const src = resolveInWorkspace(ws, from);
  const dst = resolveInWorkspace(ws, to);
  if (!fs.existsSync(src)) {
    throw new WorkspaceError(`원본이 없습니다: ${from}`, 'path_not_found');
  }
  if (fs.existsSync(dst)) {
    throw new WorkspaceError(`대상이 이미 있습니다: ${to}`, 'path_exists');
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.renameSync(src, dst);
  return { path: to };
}
