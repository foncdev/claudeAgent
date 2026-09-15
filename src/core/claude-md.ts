import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** 발견한 메모리 파일 1개. */
export interface MemoryFile {
  /** 'user' | 'project' */
  scope: string;
  path: string;
  content: string;
}

const MAX_BYTES = 64 * 1024;

function read(file: string): string | undefined {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return undefined;
    const text = fs.readFileSync(file, 'utf8').trim();
    if (!text) return undefined;
    // 시스템 프롬프트가 과도하게 길어지지 않도록 자른다.
    return text.length > MAX_BYTES ? `${text.slice(0, MAX_BYTES)}\n…(생략됨)` : text;
  } catch {
    return undefined;
  }
}

/**
 * CLAUDE.md를 모은다.
 *
 * 세션 모드는 `--setting-sources ''`로 사용자 설정을 격리하는데,
 * 그러면 사용자 전역 CLAUDE.md(~/.claude/CLAUDE.md)가 로드되지 않는다.
 * 여기서 직접 읽어 --append-system-prompt로 주입한다.
 *
 * 탐색 순서는 Claude Code와 같이 전역 → 상위 → 현재 디렉토리 순이며,
 * 가까운 파일이 뒤에 와서 더 강하게 반영되도록 한다.
 */
export function collectMemory(cwd: string, stopAt?: string): MemoryFile[] {
  const found: MemoryFile[] = [];

  // 1) 사용자 전역
  const userFile = path.join(os.homedir(), '.claude', 'CLAUDE.md');
  const userContent = read(userFile);
  if (userContent) found.push({ scope: 'user', path: userFile, content: userContent });

  // 2) 루트에서 cwd까지 내려오며 수집 (가까울수록 뒤에 온다)
  const boundary = stopAt ? path.resolve(stopAt) : path.parse(cwd).root;
  const chain: string[] = [];
  let dir = path.resolve(cwd);
  for (;;) {
    chain.unshift(dir);
    if (dir === boundary || dir === path.parse(dir).root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const seen = new Set<string>([userFile]);
  for (const d of chain) {
    for (const name of ['CLAUDE.md', 'CLAUDE.local.md']) {
      const file = path.join(d, name);
      if (seen.has(file)) continue;
      seen.add(file);
      const content = read(file);
      if (content) found.push({ scope: 'project', path: file, content });
    }
  }

  return found;
}

/** 수집한 메모리를 시스템 프롬프트에 붙일 한 덩어리로 만든다. */
export function buildMemoryPrompt(files: MemoryFile[]): string {
  if (files.length === 0) return '';
  const blocks = files.map(
    (f) => `# ${f.path}\n(${f.scope === 'user' ? '사용자 전역 설정' : '프로젝트 설정'})\n\n${f.content}`,
  );
  return [
    '다음은 이 작업에 적용되는 사용자/프로젝트 지침(CLAUDE.md)이다. 반드시 따른다.',
    '',
    blocks.join('\n\n---\n\n'),
  ].join('\n');
}
