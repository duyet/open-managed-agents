// Decision logic for which sandbox a `runSubAgent` turn executes in.
// Pure / no I/O so it's unit-testable without the Workers runtime — the
// actual sandbox minting (createSandbox) and environment record lookup
// (getEnvConfig) stay in session-do.ts, which has the DO state and env
// bindings this function doesn't need.

export type SubAgentSandboxBinding =
  | { kind: "shared" }
  | { kind: "dedicated"; environmentId: string };

/**
 * Decide whether a sub-agent (delegated via `callable_agents`) shares the
 * parent session's sandbox or gets its own dedicated executor.
 *
 *  - Roster entry has no `environment_id`, or it matches the parent
 *    session's own environment → `{ kind: "shared" }`. This is the cheap,
 *    default path and covers every existing agent config (none of them
 *    set `environment_id` today) — zero behavior change.
 *  - Roster entry names a *different* environment than the parent session
 *    → `{ kind: "dedicated", environmentId }`. Caller resolves that
 *    environment record and mints a fresh SandboxExecutor for the call.
 */
export function resolveSubAgentSandboxBinding(
  rosterEnvironmentId: string | undefined,
  parentEnvironmentId: string | undefined,
): SubAgentSandboxBinding {
  if (!rosterEnvironmentId || rosterEnvironmentId === parentEnvironmentId) {
    return { kind: "shared" };
  }
  return { kind: "dedicated", environmentId: rosterEnvironmentId };
}
