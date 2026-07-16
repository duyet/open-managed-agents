// Abstract ports the SessionService depends on. Same DIP pattern as
// packages/credentials-store/src/ports.ts — concrete adapters in src/adapters/
// implement these against Cloudflare bindings; src/test-fakes.ts provides
// in-memory implementations.
//
// Keep these tiny and runtime-agnostic: no Cloudflare types, no D1 query
// language. Pass plain data + return plain data. The schema is no-FK by
// project convention; cascade-by-{session, agent} lives in this port so
// adapters and the in-memory fake share one canonical implementation.

import type {
  AgentConfig,
  EnvironmentConfig,
  PageCursor,
  SessionResource,
  SessionStatus,
} from "@duyet/oma-shared";
import type { AnalyticsSessionRow, SessionResourceRow, SessionRow } from "./types";

export interface NewSessionInput {
  id: string;
  tenantId: string;
  agentId: string;
  environmentId: string;
  title: string;
  status: SessionStatus;
  vaultIds: string[] | null;
  agentSnapshot: AgentConfig | null;
  environmentSnapshot: EnvironmentConfig | null;
  metadata: Record<string, unknown> | null;
  createdAt: number;
}

/** Resource payload going IN to insert — id + created_at + session_id come from the service. */
export interface NewSessionResourceInput {
  id: string;
  sessionId: string;
  /** Full SessionResource shape — id/session_id/created_at fields will be overwritten. */
  resource: SessionResource;
  createdAt: number;
}

export interface SessionUpdateFields {
  title?: string;
  status?: SessionStatus;
  /**
   * Full metadata replacement after the service merges with existing.
   * Pass `null` to clear, omit to leave untouched. The service handles per-key
   * merge semantics (per sessions.ts:489-498).
   */
  metadata?: Record<string, unknown> | null;
  agentSnapshot?: AgentConfig | null;
  environmentSnapshot?: EnvironmentConfig | null;
  /**
   * Run-history summary fields (issue #21). Production writes to these
   * columns go through raw SQL in RuntimeAdapterImpl (packages/session-runtime),
   * not through this port — it's exposed here so the fields round-trip
   * through SessionRow for the GET /v1/agents/:id/runs read path, and so
   * tests can seed values without reaching into SQL directly.
   */
  stopReason?: string | null;
  toolCallCount?: number;
  messageCount?: number;
  /**
   * Cumulative session token usage. Production writes go through raw SQL in
   * RuntimeAdapterImpl (packages/session-runtime), not this port — exposed
   * here for the same reasons as the counters above (SessionRow round-trip +
   * test seeding).
   */
  inputTokens?: number;
  outputTokens?: number;
  updatedAt: number;
}

export interface SessionListOptions {
  /** Optional agent filter — uses indexed (tenant_id, agent_id) path. */
  agentId?: string;
  /** Whether to include rows with archived_at != NULL. */
  includeArchived: boolean;
  /** Sort by created_at — desc matches the GET list default (sessions.ts:393). */
  order: "asc" | "desc";
  /** Hard cap on returned rows. Adapter clamps to schema-defined max. */
  limit: number;
}

export interface SessionRepo {
  /**
   * Atomic create: session row + 0..N initial resource rows in one batch.
   * Replaces the multi-key non-atomic KV pattern (sessions.ts:285/328/342/363/375).
   */
  insertWithResources(
    session: NewSessionInput,
    resources: NewSessionResourceInput[],
  ): Promise<{ session: SessionRow; resources: SessionResourceRow[] }>;

  get(tenantId: string, sessionId: string): Promise<SessionRow | null>;

  /**
   * Cross-tenant lookup by id — replaces the `sidx:` reverse-index pattern
   * (internal.ts:381-409). `id` is globally unique so a direct WHERE id = ?
   * is O(1).
   */
  getById(sessionId: string): Promise<SessionRow | null>;

  list(tenantId: string, opts: SessionListOptions): Promise<SessionRow[]>;

  /**
   * Cursor-paginated list. Order: created_at DESC, id DESC tie-break (the
   * typical newest-first UI). Optional `agentId` filter narrows by indexed
   * column. The legacy `list` ASC option isn't carried forward — DESC is
   * the only paginated order; clients that want ASC can fetch + reverse.
   *
   * `status` (session lifecycle: idle | running | rescheduling | terminated)
   * and `q` (case-insensitive substring on title) are extra WHERE conditions
   * stacked on the cursor query — the (created_at, id) ordering is unchanged
   * so cursors stay valid across filter combinations.
   */
  listPage(
    tenantId: string,
    opts: {
      agentId?: string;
      includeArchived: boolean;
      limit: number;
      after?: PageCursor;
      /** Session lifecycle filter. Omit (or pass undefined) for no filter. */
      status?: SessionStatus;
      /** Case-insensitive substring filter against session title. Trimmed
       *  blank → unfiltered. Used by the SessionsList search box. */
      q?: string;
      /** Inclusive lower bound on created_at (epoch ms). Added for the
       *  SessionsList date-range filter — mirrors the agents list route. */
      createdAfter?: number;
      /** Exclusive upper bound on created_at (epoch ms). */
      createdBefore?: number;
    },
  ): Promise<{ items: SessionRow[]; hasMore: boolean }>;

  /**
   * Project the analytics-relevant columns for every session in a tenant
   * (optionally one agent) whose created_at falls in [startMs, endMs).
   * Includes archived sessions — they still happened and belong in historical
   * counts. Bucketing / percentiles are computed in JS by the service, so this
   * stays a plain indexed range scan with no dialect-specific SQL.
   */
  listForAnalytics(
    tenantId: string,
    opts: { agentId?: string; startMs: number; endMs: number },
  ): Promise<AnalyticsSessionRow[]>;

  /** Returns true if any non-archived session in the tenant references this agent. */
  hasActiveByAgent(tenantId: string, agentId: string): Promise<boolean>;

  /** Returns true if any non-archived session in the tenant references this environment. */
  hasActiveByEnvironment(tenantId: string, environmentId: string): Promise<boolean>;

  /** Cheap COUNT(*) for /v1/stats. Index `idx_sessions_tenant_created` covers it. */
  count(tenantId: string, opts: { includeArchived: boolean }): Promise<number>;

  update(
    tenantId: string,
    sessionId: string,
    update: SessionUpdateFields,
  ): Promise<SessionRow>;

  archive(tenantId: string, sessionId: string, archivedAt: number): Promise<SessionRow>;

  /** Hard-delete a session AND cascade-delete its session_resources in one batch. */
  deleteWithResources(tenantId: string, sessionId: string): Promise<void>;

  /**
   * Cascade hard-delete every session for an agent (and all their resources).
   * Replaces the KV list+filter loop in agents.ts:340-348 / cleanup paths.
   * Returns the count of sessions deleted (so callers can log + emit metrics).
   */
  deleteByAgent(tenantId: string, agentId: string): Promise<number>;

  // ── session_resources operations ──

  insertResource(input: NewSessionResourceInput): Promise<SessionResourceRow>;

  /** Fetch a single resource. Tenant ownership is verified at the service layer
   * via a session lookup; the resource row carries no tenant_id by design (it
   * inherits from session_id). */
  getResource(sessionId: string, resourceId: string): Promise<SessionResourceRow | null>;

  listResources(sessionId: string): Promise<SessionResourceRow[]>;

  countResources(sessionId: string): Promise<number>;

  /** Per-type count for the memory_store quota check (sessions.ts:884-895). */
  countResourcesByType(sessionId: string, type: SessionResource["type"]): Promise<number>;

  deleteResource(sessionId: string, resourceId: string): Promise<void>;

  /** Replace the resource JSON column. The resource id and session id stay
   *  immutable; the rest of the SessionResource payload is overwritten with
   *  what the caller passes. AMA models PATCH /resources/:id as a body
   *  replacement on the SessionResource shape. */
  updateResource(
    sessionId: string,
    resourceId: string,
    resource: SessionResource,
  ): Promise<SessionResourceRow>;

  /** Wipe every resource for a session — used by /destroy paths and tests. */
  deleteAllResourcesForSession(sessionId: string): Promise<void>;
}

export interface Clock {
  nowMs(): number;
}

export interface IdGenerator {
  sessionId(): string;
  resourceId(): string;
}

export interface Logger {
  warn(msg: string, ctx?: unknown): void;
}
