// Public types for the sessions store service. Mirrors the D1 schema in
// apps/main/migrations/0010_sessions_tables.sql.
//
// Design choices:
//   - SessionRow holds the full session record incl. agent_snapshot /
//     environment_snapshot (frozen at create time so trajectory + replay still
//     work after the agent or env definition mutates).
//   - SessionResourceRow keeps the discriminated SessionResource shape from
//     @duyet/oma-shared as the resource payload — adapters JSON.parse
//     the `config` column. The full SessionResource is round-tripped through
//     `config` for symmetry across resource types; a denormalized `type` column
//     supports the per-type quota count without touching JSON.
//   - The actual secret values for `github_repository.authorization_token` and
//     `env.value` (legacy: `env_secret.value`) are NOT stored here — they
//     continue to live in CONFIG_KV under
//     `t:{tenant}:secret:{session}:{resource}` keys, owned by the route layer
//     (sessions.ts:361/374, internal.ts:315). This store is intentionally
//     write-once for resource metadata only.

import type {
  AgentConfig,
  EnvironmentConfig,
  SessionResource,
  SessionStatus,
} from "@duyet/oma-shared";

export interface SessionRow {
  id: string;
  tenant_id: string;
  agent_id: string | null;
  environment_id: string | null;
  title: string;
  status: SessionStatus;
  /** Vault IDs attached to the session — used by SessionDO for outbound credential lookup. */
  vault_ids: string[] | null;
  /** Frozen agent definition at session-create time. Null only for tests / legacy paths. */
  agent_snapshot: AgentConfig | null;
  /** Frozen environment definition at session-create time. */
  environment_snapshot: EnvironmentConfig | null;
  /** Caller-supplied free-form metadata (Linear webhook context, eval-run id, etc.). */
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string | null;
  archived_at: string | null;
  /** Set when SessionDO drives the session to AMA's terminated terminus
   *  (POST /events returns 409 going forward). null means not terminated. */
  terminated_at: string | null;
  /** Run-history summary (issue #21) — refreshed by
   *  RuntimeAdapterImpl.endTurn/terminate (packages/session-runtime) on
   *  every idle/destroyed/terminated transition, not written through this
   *  service. `stop_reason` is one of "end_turn" | "destroyed" |
   *  "terminated", or null before the session's first turn completes.
   *  `tool_call_count` / `message_count` are cumulative totals for the
   *  whole session, recomputed from the event log on each transition. */
  stop_reason: string | null;
  tool_call_count: number;
  message_count: number;
}

export interface SessionResourceRow {
  id: string;
  session_id: string;
  type: SessionResource["type"];
  /** Full SessionResource payload — adapters JSON.parse the `config` column. */
  resource: SessionResource;
  created_at: string;
}

/** Hard cap, mirrored from sessions.ts:869. Per-session resource ceiling. */
export const MAX_RESOURCES_PER_SESSION = 100;

/** Hard cap, mirrored from sessions.ts:188 + sessions.ts:893. Anthropic-aligned. */
export const MAX_MEMORY_STORE_RESOURCES_PER_SESSION = 8;
