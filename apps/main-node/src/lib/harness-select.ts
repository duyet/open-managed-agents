// Picks which harness implementation runs a turn. An agent's own
// `metadata.harness` always wins; DEFAULT_HARNESS is a node-self-host-only
// env var that opts every agent lacking that marker into a non-default
// harness (e.g. "claude-agent-sdk") without editing each agent config.
export function selectHarnessName(
  agentMetaHarness: unknown,
  envDefaultHarness: string | undefined,
): string | undefined {
  if (typeof agentMetaHarness === "string" && agentMetaHarness) return agentMetaHarness;
  return envDefaultHarness || undefined;
}
