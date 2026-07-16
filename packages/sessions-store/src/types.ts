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
  /** Cumulative model token usage for the whole session — summed from
   *  span.model_request_end events by RuntimeAdapterImpl.endTurn/terminate on
   *  every idle/destroyed/terminated transition (same path as the counters
   *  above). 0 before the session's first turn completes. Backs the
   *  Observability analytics endpoints and the sessions list "tokens in/out"
   *  column. */
  input_tokens: number;
  output_tokens: number;
}

/** One session's aggregate-relevant columns, projected for analytics. Kept
 *  minimal so a range scan stays cheap and dialect-agnostic — all bucketing
 *  and percentile math happens in JS (see computeSessionAnalytics). */
export interface AnalyticsSessionRow {
  /** Session create time in epoch ms. */
  created_at: number;
  input_tokens: number;
  output_tokens: number;
  tool_call_count: number;
  message_count: number;
  stop_reason: string | null;
}

/** Percentile triple over a per-session distribution. */
export interface Percentiles {
  p50: number;
  p90: number;
  p95: number;
}

/**
 * Aggregated session analytics for a tenant (optionally scoped to one agent)
 * over a time range. Consumed as-is by the Console Observability tab.
 *
 * `tool_usage` and `stop_reasons` are optional: per-tool-name aggregation is
 * NOT available from control-plane data (only a per-session `tool_call_count`
 * total is persisted — individual tool names live in the DO event log), so
 * `tool_usage` is always omitted and `total_tool_calls` carries the only
 * cross-session tool signal available. `stop_reasons` IS derivable from the
 * persisted `stop_reason` column and is populated.
 */
export interface SessionAnalytics {
  range: string;
  /** Inclusive range start (ISO-8601). */
  start: string;
  /** Exclusive range end (ISO-8601). */
  end: string;
  total_sessions: number;
  /** Sessions that completed at least one turn (stop_reason IS NOT NULL). */
  completed_sessions: number;
  /** Sessions whose turn ended via the destroy path (stop_reason='destroyed').
   *  The only abnormal-termination signal persisted in the control plane. */
  error_count: number;
  /** error_count / completed_sessions (0 when no completed sessions). */
  error_rate: number;
  tokens: {
    input: number;
    output: number;
    total: number;
    per_session: {
      input: Percentiles;
      output: Percentiles;
      total: Percentiles;
    };
  };
  /** Total agent messages across sessions — a proxy for total turns. */
  total_turns: number;
  turns_per_session: Percentiles;
  /** Sum of per-session tool_call_count over the range. */
  total_tool_calls: number;
  /** Daily session-count buckets (UTC), one entry per day in range incl. zeros. */
  sessions_over_time: Array<{ date: string; count: number }>;
  /** Stop-reason breakdown over the range (populated). */
  stop_reasons?: Array<{ stop_reason: string; count: number }>;
  /** Per-tool-name usage — always omitted (not available cross-session). */
  tool_usage?: Array<{ name: string; count: number }>;
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
