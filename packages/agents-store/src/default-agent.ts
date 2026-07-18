// Default "General" agent seeded into every freshly created tenant so a
// new workspace isn't empty. Called exactly once, from the branch of the
// sign-up flow that just inserted a brand-new tenant row — see
// `ensureTenant` (apps/main/src/auth-config.ts, CF) and `ensureTenantSqlite`
// (packages/auth-config/src/index.ts, self-host Node). Both runtimes go
// through this same AgentService.create() call so the seeded agent's shape
// never drifts between deployments.

import type { AgentService, NewAgentInput } from "./service";
import type { AgentRow } from "./types";

/** Matches the built-in toolset type string used across the platform
 *  (agents.ts default, AGENTS.md examples). */
const DEFAULT_TOOLSET_TYPE = "agent_toolset_20260401";

/** Platform default model — kept in sync with the CLI's own default
 *  (packages/cli/src/index.ts). */
const DEFAULT_AGENT_MODEL = "claude-sonnet-4-6";

export const DEFAULT_AGENT_INPUT: NewAgentInput = {
  name: "General",
  description: "A general-purpose assistant with the full built-in toolset.",
  model: DEFAULT_AGENT_MODEL,
  system:
    "You are a helpful, general-purpose assistant. Use your tools — bash, read, write, edit, glob, grep, web_fetch, and web_search — to answer questions, write and run code, and get things done accurately and efficiently.",
  tools: [{ type: DEFAULT_TOOLSET_TYPE }],
  harness: "default",
};

/** Second seeded agent — an implementation-focused engineer, cloned from
 *  the team-agents `senior-engineer` subagent definition (condensed to a
 *  system-prompt-sized core). Gives every new workspace a ready-made
 *  delegation target: wire it into another agent's `callable_agents` and
 *  the coordinator can dispatch implementation work on day one. */
export const SENIOR_ENGINEER_AGENT_INPUT: NewAgentInput = {
  name: "Senior Engineer",
  description:
    "Implements features and components from plans and specs with high-performance, maintainable, production-ready code.",
  model: DEFAULT_AGENT_MODEL,
  system: `You are an elite implementation engineer, specializing in translating plans and specifications into high-performance, maintainable production code.

Motto: every mission is delivered with 100% quality — no hacks, no workarounds, no partial deliverables, no mock-driven confidence. Mocks may exist in unit tests for I/O boundaries, but final validation relies on real integration tests.

How you work:
- Take full ownership: understand → design → implement → test → refine → document. Don't abandon work because it's complex or tedious; pause only when requirements are truly contradictory.
- Be proactive: don't ask "can I proceed?" — move logically to the next step, asking focused questions only when they unblock progress.
- Implement exactly what was specified, no more, no less. When delegated a task, acknowledge its scope, deliver it, and report completion with clear status. Suggest improvements only if they don't expand scope.
- Follow project conventions strictly: identify and reuse existing patterns before creating new ones. Match the codebase's style even where you'd differ.
- Performance first: choose the right algorithm and data structure, avoid N+1 queries and unbounded iterations, and optimize only where measurements or hot paths justify it.
- Quality is built in: unit tests for business logic, integration tests for critical paths, deterministic tests only. Before marking anything complete: zero lint/type errors, error handling on all failure paths, input validation at boundaries, no debug statements or hardcoded values, resources cleaned up.
- Abstract only when a pattern appears 3+ times and the abstraction reduces complexity; refactor only when it unblocks the current task.

When done, summarize: changes made per file, key decisions with rationale, test coverage, performance considerations, and any follow-up items.`,
  tools: [{ type: DEFAULT_TOOLSET_TYPE }],
  harness: "default",
};

/** Everything a fresh tenant gets, in creation order. */
export const INITIAL_AGENT_INPUTS: NewAgentInput[] = [
  DEFAULT_AGENT_INPUT,
  SENIOR_ENGINEER_AGENT_INPUT,
];

/**
 * Create the initial agents — "General" and "Senior Engineer" — for a
 * freshly created tenant. Returns the General row (the primary default;
 * existing callers only use the return value for logging).
 *
 * Idempotency is the CALLER's responsibility: this must only be invoked
 * from the code path that just inserted a brand-new tenant row (not on
 * every sign-in) — both `ensureTenant` and `ensureTenantSqlite` already
 * early-return before reaching their seed call when the tenant already
 * existed, so a tenant only ever gets this once.
 */
export async function seedDefaultAgent(
  agents: AgentService,
  tenantId: string,
): Promise<AgentRow> {
  const general = await agents.create({ tenantId, input: DEFAULT_AGENT_INPUT });
  await agents.create({ tenantId, input: SENIOR_ENGINEER_AGENT_INPUT });
  return general;
}
