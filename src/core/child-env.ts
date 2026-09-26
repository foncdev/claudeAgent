/**
 * Claude CLI에 넘길 환경변수.
 *
 * .env를 읽으면 AGENT_API_KEY·RELAY_AGENT_TOKEN까지 process.env에 들어간다.
 * 그대로 넘기면 Claude가 `echo $AGENT_API_KEY` 한 번으로 매니저 키를 얻고,
 * 그 키로 자기 세션을 auto-approve로 바꾸거나 대기 중인 권한 요청을 스스로
 * 승인할 수 있었다. 이 매니저와 relay의 설정은 CLI가 쓸 일이 없으므로 뺀다.
 *
 * ANTHROPIC_API_KEY 같은 CLI 자신의 설정은 그대로 둔다.
 */
const PRIVATE_PREFIXES = ['AGENT_', 'RELAY_'];

export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (PRIVATE_PREFIXES.some((p) => key.startsWith(p))) continue;
    env[key] = value;
  }
  return { ...env, CLAUDE_CODE_ENTRYPOINT: 'agent-cli-manager', ...extra };
}
