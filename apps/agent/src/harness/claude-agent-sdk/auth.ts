/**
 * Auth selection for ClaudeAgentSdkHarness's CLI subprocess. Kept in its own
 * module (no import of `@anthropic-ai/claude-agent-sdk`) so it can be unit
 * tested under the Cloudflare-Workers-pool test suite without pulling in the
 * SDK's Node-only subprocess machinery — mirrors why `translate.ts` is split
 * out from `sandbox-tools.ts` in this same directory.
 */

/**
 * Choose which auth mechanism the Claude Agent SDK's CLI subprocess should
 * use for this turn. ANTHROPIC_API_KEY is OMA's existing default; when it's
 * unset, CLAUDE_CODE_OAUTH_TOKEN (minted via `claude setup-token`) is the
 * CLI's own long-lived, non-interactive alternative for CI/CD — the CLI
 * reads it directly from its subprocess environment, same as
 * ANTHROPIC_API_KEY, so no SDK option is involved. Returns null when
 * neither is set.
 */
export function resolveClaudeSdkAuth(env: {
  ANTHROPIC_API_KEY?: string;
  CLAUDE_CODE_OAUTH_TOKEN?: string;
}): { ANTHROPIC_API_KEY: string } | { CLAUDE_CODE_OAUTH_TOKEN: string } | null {
  if (env.ANTHROPIC_API_KEY) return { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY };
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return { CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN };
  return null;
}
