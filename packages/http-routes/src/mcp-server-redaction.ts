// Read/write contract for `AgentConfig.mcp_servers[].authorization_token` —
// see issue #196. OMA's credential story is that secrets live in vaults and
// are resolved live, never snapshotted anywhere a low-privilege read can see
// them. `authorization_token` is a documented escape hatch that lets a caller
// inline a literal bearer token on an mcp_servers entry instead — it was
// being stored as plain JSON on the AgentConfig row and echoed back verbatim
// on every read. These two functions are the read-side and write-side halves
// of closing that: redact on the way out, reconcile on the way back in so a
// redacted read -> unmodified write round-trip doesn't clobber the stored
// token with nothing.
//
// Deliberately NOT applied to the AgentConfig row itself, nor to a session's
// `agent_snapshot` copy (packages/http-routes/src/sessions/index.ts creates
// it straight from the raw agent row at session-create time) — both must
// keep the real token, because the MCP proxy resolves credentials directly
// off `agent_snapshot.mcp_servers[].authorization_token`
// (apps/main/src/routes/mcp-proxy.ts, apps/main-node/src/mcp-proxy.ts).
// Redaction only ever happens at the HTTP response boundary.

import type { AgentConfig } from "@duyet/oma-shared";

type McpServerConfigEntry = NonNullable<AgentConfig["mcp_servers"]>[number];

/**
 * Strip `authorization_token` from every mcp_servers entry before it reaches
 * an API response. `has_authorization_token` tells the caller (e.g. the
 * Console's agent-edit form) whether one is configured, without ever
 * exposing the plaintext value. Used by every serialization seam that
 * echoes a raw AgentConfig back to a client: the agents routes
 * (GET/POST/PUT responses, version history) and the sessions routes
 * (agent_snapshot embedded in a session's `agent` field).
 */
export function redactMcpServers(
  servers: AgentConfig["mcp_servers"],
): AgentConfig["mcp_servers"] {
  if (!servers) return servers;
  return servers.map((s) => {
    if (!s.authorization_token) return s;
    const { authorization_token: _tok, ...rest } = s;
    return { ...rest, has_authorization_token: true };
  });
}

/**
 * Reconcile `mcp_servers[].authorization_token` on a create/update request
 * against the agent's existing stored config. Because reads never echo a
 * real token back (see `redactMcpServers` above), a client that fetches an
 * agent, edits some unrelated field, and writes the whole object back sends
 * no `authorization_token` key at all for entries that already have one.
 * Mirrors the write-only-secret convention already used for sensitive
 * environment variables (packages/http-routes/src/environments/env-vars.ts):
 *   - key absent on the incoming entry  -> keep whatever's already stored
 *     for that server name
 *   - explicit `null` or `""`           -> clear it
 *   - any other string                  -> set / rotate
 *
 * `existing` is undefined on create (nothing to preserve yet); every entry's
 * token is taken at face value in that case.
 */
export function reconcileMcpServerTokens(
  incoming: Array<Record<string, unknown>>,
  existing: AgentConfig["mcp_servers"] | undefined,
): Array<Record<string, unknown>> {
  const existingByName = new Map<string, string | undefined>(
    (existing ?? []).map((s: McpServerConfigEntry) => [s.name, s.authorization_token]),
  );
  return incoming.map((entry) => {
    if (!("authorization_token" in entry)) {
      const name = typeof entry.name === "string" ? entry.name : undefined;
      const prior = name ? existingByName.get(name) : undefined;
      return prior ? { ...entry, authorization_token: prior } : entry;
    }
    const token = entry.authorization_token;
    if (token === null || token === "") {
      const { authorization_token: _drop, ...rest } = entry;
      return rest;
    }
    return entry;
  });
}
