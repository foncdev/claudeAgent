/** 권한 결정 정책. */
export type PolicyMode = 'ask-risky' | 'ask-all' | 'auto-approve';

/** 부작용이 없는 읽기 전용 도구. 기본 정책에서 자동 승인한다. */
const READ_ONLY_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'NotebookRead',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
  'ListAgents',
  'LSP',
  'ToolSearch',
  'Skill',
]);

/** Bash 중에서도 상태를 바꾸지 않는 것이 명백한 명령. */
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
  /^echo\s/,
  /^git (status|log|diff|show|branch)(\s|$)/,
];

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

  // MCP 도구는 무엇을 하는지 알 수 없으므로 확인한다.
  if (toolName.startsWith('mcp__')) {
    return { autoApprove: false, reason: '외부 MCP 도구' };
  }

  if (toolName === 'Bash') {
    const command = String((input as { command?: unknown } | null)?.command ?? '').trim();
    // 여러 명령이 이어진 경우 전부 안전해야 통과시킨다.
    const parts = command.split(/&&|\|\||;|\|/).map((p) => p.trim()).filter(Boolean);
    const allSafe =
      parts.length > 0 && parts.every((p) => SAFE_BASH.some((re) => re.test(p)));
    return allSafe
      ? { autoApprove: true, reason: '읽기 전용 셸 명령' }
      : { autoApprove: false, reason: '상태를 바꿀 수 있는 셸 명령' };
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
