import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 권한 결정 정책. */
export type PolicyMode = 'ask-risky' | 'ask-all' | 'auto-approve';

/**
 * 부작용이 없는 도구. 기본 정책에서 자동 승인한다.
 *
 * 파일을 읽는 도구는 여기 없다. 세션 작업 폴더 안을 읽을 때만 통과시키고
 * (FILE_TOOLS), 밖이면 묻는다. 예전에는 Read가 어디든 자동 승인이라
 * ~/.ssh나 다른 저장소의 .env까지 확인 없이 읽혔다.
 *
 * WebFetch·WebSearch도 뺐다. 읽은 비밀을 주소나 검색어에 실어 내보내는
 * 통로가 되므로, 밖으로 나가는 요청은 사람이 본다.
 */
const READ_ONLY_TOOLS = new Set(['TodoWrite', 'ListAgents', 'ToolSearch', 'Skill']);

/** 파일을 읽는 도구와, 입력에서 경로가 들어오는 자리. */
const FILE_TOOLS: Record<string, string[]> = {
  Read: ['file_path'],
  NotebookRead: ['notebook_path'],
  // path를 비우면 작업 폴더를 뒤진다.
  Grep: ['path'],
  // pattern이 절대 경로면 폴더 밖을 훑을 수 있다.
  Glob: ['path', 'pattern'],
  LSP: ['filePath', 'file_path', 'path'],
};

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** 있는 데까지 심볼릭 링크를 풀고, 없는 나머지는 그대로 이어 붙인다. */
function realish(p: string): string {
  let probe = p;
  for (;;) {
    try {
      const real = fs.realpathSync(probe);
      const rest = path.relative(probe, p);
      return rest ? path.join(real, rest) : real;
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return p;
      probe = parent;
    }
  }
}

/**
 * 경로가 작업 폴더 안인지. 심볼릭 링크로 빠져나가는 것도 본다.
 * 작업 폴더를 모르면 안이라고 볼 근거가 없으므로 false다.
 */
export function insideCwd(p: string, cwd: string | undefined): boolean {
  if (!cwd) return false;
  const root = realish(path.resolve(cwd));
  const target = realish(path.resolve(root, expandHome(p)));
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 파일 도구의 입력이 전부 작업 폴더 안을 가리키는지. 경로를 안 주면 작업 폴더다. */
function fileToolInside(toolName: string, input: unknown, cwd: string | undefined): boolean {
  const obj = (input ?? {}) as Record<string, unknown>;
  return FILE_TOOLS[toolName]!.every((key) => {
    const v = obj[key];
    if (v === undefined || v === '') return cwd !== undefined;
    return typeof v === 'string' && insideCwd(v, cwd);
  });
}

/**
 * Bash 중에서도 상태를 바꾸지 않는 것이 명백한 명령.
 *
 * 앞머리만 보고 판단하므로, 같은 명령이라도 뒤에 붙는 옵션에 따라 쓰기가
 * 되는 경우는 UNSAFE_ARGS에서 따로 막는다.
 */
const SAFE_BASH = [
  /^ls(\s|$)/,
  /^pwd(\s|$)/,
  /^cat\s/,
  /^head\s/,
  /^tail\s/,
  /^grep\s/,
  /^rg\s/,
  /^find\s/,
  /^wc\s/,
  /^which\s/,
  /^echo(\s|$)/,
  /^git (status|log|diff|show)(\s|$)/,
  // branch는 목록을 볼 때만. 이름을 붙이면 만들고, -d·-m 등은 지우거나 옮긴다.
  /^git branch(\s+(-a|-r|-v|-vv|--all|--remotes|--verbose|--show-current))*$/,
];

/**
 * 셸 문법 중 명령을 숨기거나 파일을 쓰는 것.
 *
 * 명령을 &&·||·;·|로만 나눠 보면 이 틈으로 빠져나간다. 예전에는
 * "ls⏎rm -rf ~"(줄바꿈), "ls & rm …"(백그라운드), "echo x > ~/.zshrc"
 * (리다이렉트), "echo `rm …`"(명령 치환)가 전부 자동 승인됐다.
 * 이 중 하나라도 있으면 나누지 않고 사람에게 묻는다.
 */
const SHELL_ESCAPES = [
  /[\r\n]/, // 줄바꿈 — 한 줄에 명령 여럿
  /&/, // 백그라운드. &&는 미리 ;로 바꿔 두므로 여기 걸리는 것은 단일 &뿐이다
  /[<>]/, // 리다이렉트·here-doc·프로세스 치환
  /`/, // 명령 치환
  /\$\(/, // 명령 치환
  /\$\{[^}]*[:=?+-]/, // ${x:=...} 같은 대입·조건 전개
];

/** 앞머리는 안전해 보여도 이 옵션이 붙으면 쓰거나 다른 프로그램을 실행한다. */
const UNSAFE_ARGS: Array<[RegExp, RegExp]> = [
  [/^find\s/, /\s-(delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)\b/],
  // --pre는 파일마다 임의 프로그램을 돌린다.
  [/^rg\s/, /\s--pre(=|\s|$)|\s--pre-glob/],
  // --output은 diff 계열 공통 옵션으로 파일을 쓴다. --ext-diff는 외부 프로그램을 부른다.
  [/^git\s/, /\s--(output|ext-diff)\b/],
];

/**
 * 인자 중 경로로 보이는 것이 전부 작업 폴더 안인지.
 *
 * cat·grep·find는 읽기만 하지만 `cat ~/.ssh/id_rsa`처럼 어디든 읽는다.
 * /·~로 시작하거나 ..을 거치는 인자, 실제로 있는 인자는 링크까지 풀어
 * 보고, 밖이면 묻는다.
 * $가 들어간 인자는 무엇으로 펼쳐질지 모르므로 묻는다($HOME/.ssh 등).
 */
function argsInside(part: string, cwd: string | undefined): boolean {
  for (const raw of part.split(/\s+/).slice(1)) {
    const token = raw.replace(/^['"]|['"]$/g, '');
    if (token.includes('$')) return false;
    // --file=/etc/x 같은 꼴은 = 뒤를 본다.
    const value = token.startsWith('-') && token.includes('=') ? token.slice(token.indexOf('=') + 1) : token;
    const looksLikePath =
      value.startsWith('/') || value.startsWith('~') || value.split('/').includes('..');
    // 평범한 이름이라도 실제로 있으면 풀어 본다. 작업 폴더 안의 링크가
    // 밖을 가리킬 수 있다(`cat link/.env`).
    const exists = cwd !== undefined && value !== '' && fs.existsSync(path.resolve(cwd, value));
    if ((looksLikePath || exists) && !insideCwd(value, cwd)) return false;
  }
  return true;
}

/** 셸 명령 하나가 읽기 전용이고 작업 폴더 안만 보는 것이 명백한지. */
export function isSafeBash(command: string, cwd?: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  // &&는 ;와 같이 나누는 자리다. 먼저 바꿔 두어야 단일 &만 골라낼 수 있다.
  const joined = trimmed.replace(/&&/g, ';');
  // &&·||·;·| 외의 셸 문법이 끼어 있으면 나눠 보는 것 자체를 믿을 수 없다.
  if (SHELL_ESCAPES.some((re) => re.test(joined))) return false;

  const parts = joined
    .split(/\|\||;|\|/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return false;
  return parts.every(
    (p) =>
      SAFE_BASH.some((re) => re.test(p)) &&
      !UNSAFE_ARGS.some(([cmd, arg]) => cmd.test(p) && arg.test(` ${p.slice(p.indexOf(' ') + 1)}`)) &&
      argsInside(p, cwd),
  );
}

export interface PolicyDecision {
  /** true면 사용자에게 묻지 않고 바로 통과시킨다. */
  autoApprove: boolean;
  reason: string;
}

/**
 * 도구 실행을 자동 승인할지 판단한다.
 * 판단이 애매하면 사용자에게 묻는 쪽(autoApprove: false)으로 기운다.
 */
export function evaluate(
  mode: PolicyMode,
  toolName: string,
  input: unknown,
  /** 세션 작업 폴더. 파일을 읽는 도구가 그 안을 보는지 가리는 데 쓴다. */
  cwd?: string,
): PolicyDecision {
  if (mode === 'auto-approve') {
    return { autoApprove: true, reason: '자동 승인 모드' };
  }
  if (mode === 'ask-all') {
    return { autoApprove: false, reason: '모든 도구 확인 모드' };
  }

  // ask-risky: 읽기 전용은 통과시킨다.
  if (READ_ONLY_TOOLS.has(toolName)) {
    return { autoApprove: true, reason: '읽기 전용 도구' };
  }

  // 파일 읽기는 작업 폴더 안일 때만 통과시킨다.
  if (toolName in FILE_TOOLS) {
    return fileToolInside(toolName, input, cwd)
      ? { autoApprove: true, reason: '작업 폴더 안 읽기' }
      : { autoApprove: false, reason: '작업 폴더 밖 읽기' };
  }

  if (toolName === 'WebFetch' || toolName === 'WebSearch') {
    return { autoApprove: false, reason: '외부로 나가는 요청' };
  }

  // MCP 도구는 무엇을 하는지 알 수 없으므로 확인한다.
  if (toolName.startsWith('mcp__')) {
    return { autoApprove: false, reason: '외부 MCP 도구' };
  }

  if (toolName === 'Bash') {
    const command = String((input as { command?: unknown } | null)?.command ?? '');
    return isSafeBash(command, cwd)
      ? { autoApprove: true, reason: '읽기 전용 셸 명령' }
      : { autoApprove: false, reason: '상태를 바꾸거나 작업 폴더 밖을 보는 셸 명령' };
  }

  return { autoApprove: false, reason: '쓰기 가능 도구' };
}

/** 권한 요청을 사람이 읽기 좋게 한 줄로 요약한다. */
export function summarize(toolName: string, input: unknown): string {
  const obj = (input ?? {}) as Record<string, unknown>;
  switch (toolName) {
    case 'Bash':
      return String(obj.command ?? '');
    case 'Write':
    case 'Edit':
    case 'Read':
      return String(obj.file_path ?? '');
    case 'WebFetch':
      return String(obj.url ?? '');
    default: {
      const json = JSON.stringify(obj);
      return json.length > 160 ? `${json.slice(0, 160)}…` : json;
    }
  }
}
