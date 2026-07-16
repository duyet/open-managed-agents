import {
  generateResourceId,
  generateSessionId,
} from "@duyet/oma-shared";
import { paginateVia } from "@duyet/oma-shared";
import type {
  AgentConfig,
  EnvironmentConfig,
  SessionResource,
  SessionStatus,
} from "@duyet/oma-shared";
import {
  SessionArchivedError,
  SessionMemoryStoreMaxExceededError,
  SessionNotFoundError,
  SessionResourceMaxExceededError,
  SessionResourceNotFoundError,
} from "./errors";
import type {
  Clock,
  IdGenerator,
  Logger,
  NewSessionResourceInput,
  SessionListOptions,
  SessionRepo,
  SessionUpdateFields,
} from "./ports";
import {
  MAX_MEMORY_STORE_RESOURCES_PER_SESSION,
  MAX_RESOURCES_PER_SESSION,
  SessionResourceRow,
  SessionRow,
} from "./types";
import type {
  AnalyticsSessionRow,
  Percentiles,
  SessionAnalytics,
} from "./types";

export interface SessionServiceDeps {
  repo: SessionRepo;
  clock?: Clock;
  ids?: IdGenerator;
  logger?: Logger;
}

/** Resource input shape for create/addResource — id + session_id + created_at
 *  are always assigned by the service. Callers pass the SessionResource sans
 *  those fields. */
export type NewResourceInput = Omit<SessionResource, "id" | "session_id" | "created_at">;

/**
 * SessionService — pure business logic over abstract ports.
 *
 * Owns:
 *   - per-session resource quota (MAX_RESOURCES_PER_SESSION) — was sessions.ts:869
 *   - per-session memory_store quota (MAX_MEMORY_STORE_RESOURCES_PER_SESSION) — was sessions.ts:188 + 893
 *   - archived-session immutability for new resources (sessions.ts:541 was for events;
 *     we apply the same block to resource adds for consistency)
 *   - cascade delete on session.delete (sessions, resources)
 *   - cascade delete on agent.delete (sessions.ts O(N) scan replacement)
 *   - sidx-style cross-tenant lookup via getById
 *   - metadata merge semantics (per-key delete on null) — was sessions.ts:489-498
 *
 * Does NOT own:
 *   - secret materials (env.value, github_repository.authorization_token).
 *     Those continue to live in CONFIG_KV under `t:{tenant}:secret:...` keys
 *     because they're write-only blobs the route layer reads alongside the
 *     resource. Sessions store records resource METADATA only.
 *   - file copy / R2 ops at session create — caller (route) handles those
 *     before calling service.create.
 *   - sandbox lifecycle (init/destroy) — handled by the route via the sandbox
 *     binding.
 */
export class SessionService {
  private readonly repo: SessionRepo;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly logger: Logger;

  constructor(deps: SessionServiceDeps) {
    this.repo = deps.repo;
    this.clock = deps.clock ?? defaultClock;
    this.ids = deps.ids ?? defaultIds;
    this.logger = deps.logger ?? consoleLogger;
  }

  // ============================================================
  // Write paths
  // ============================================================

  /**
   * Atomic session create. Optionally accepts initial resources — those are
   * inserted in the same D1 batch as the session row, replacing the KV-era
   * partial-failure window where a session existed but its resources didn't.
   *
   * Pre-validates per-session caps so a 21st memory_store at create time fails
   * before the batch fires.
   */
  async create(opts: {
    tenantId: string;
    agentId: string;
    environmentId: string;
    title?: string;
    status?: SessionStatus;
    vaultIds?: string[];
    agentSnapshot?: AgentConfig;
    environmentSnapshot?: EnvironmentConfig;
    metadata?: Record<string, unknown>;
    resources?: NewResourceInput[];
  }): Promise<{ session: SessionRow; resources: SessionResourceRow[] }> {
    const resources = opts.resources ?? [];
    if (resources.length > MAX_RESOURCES_PER_SESSION) {
      throw new SessionResourceMaxExceededError(MAX_RESOURCES_PER_SESSION);
    }
    const memoryStoreCount = resources.filter((r) => r.type === "memory_store").length;
    if (memoryStoreCount > MAX_MEMORY_STORE_RESOURCES_PER_SESSION) {
      throw new SessionMemoryStoreMaxExceededError(MAX_MEMORY_STORE_RESOURCES_PER_SESSION);
    }

    const sessionId = this.ids.sessionId();
    const createdAt = this.clock.nowMs();

    const resourceInputs: NewSessionResourceInput[] = resources.map((r) => {
      const resourceId = this.ids.resourceId();
      return {
        id: resourceId,
        sessionId,
        createdAt,
        // Stamp id + session_id + created_at on the embedded resource so the
        // round-tripped JSON matches the row's identity.
        resource: {
          ...(r as SessionResource),
          id: resourceId,
          session_id: sessionId,
          created_at: new Date(createdAt).toISOString(),
        },
      };
    });

    return await this.repo.insertWithResources(
      {
        id: sessionId,
        tenantId: opts.tenantId,
        agentId: opts.agentId,
        environmentId: opts.environmentId,
        title: opts.title ?? "",
        status: opts.status ?? "idle",
        vaultIds: opts.vaultIds ?? null,
        agentSnapshot: opts.agentSnapshot ?? null,
        environmentSnapshot: opts.environmentSnapshot ?? null,
        metadata: opts.metadata ?? null,
        createdAt,
      },
      resourceInputs,
    );
  }

  /**
   * Patch a session: title, metadata (merge with per-key delete on null),
   * status, snapshots. Bumps updated_at. Mirrors POST /v1/sessions/:id behavior
   * (sessions.ts:477-504).
   */
  async update(opts: {
    tenantId: string;
    sessionId: string;
    title?: string;
    /** Per-key merge — pass `{ key: null }` to drop a key. Pass undefined to skip. */
    metadata?: Record<string, unknown>;
    status?: SessionStatus;
    agentSnapshot?: AgentConfig;
    environmentSnapshot?: EnvironmentConfig;
  }): Promise<SessionRow> {
    const existing = await this.requireSession(opts);
    const update: SessionUpdateFields = { updatedAt: this.clock.nowMs() };
    if (opts.title !== undefined) update.title = opts.title;
    if (opts.status !== undefined) update.status = opts.status;
    if (opts.agentSnapshot !== undefined) update.agentSnapshot = opts.agentSnapshot;
    if (opts.environmentSnapshot !== undefined) update.environmentSnapshot = opts.environmentSnapshot;
    if (opts.metadata !== undefined) {
      update.metadata = mergeMetadata(existing.metadata, opts.metadata);
    }
    return this.repo.update(opts.tenantId, opts.sessionId, update);
  }

  /** Just status — convenience for the SessionDO write-back path. */
  async updateStatus(opts: {
    tenantId: string;
    sessionId: string;
    status: SessionStatus;
  }): Promise<SessionRow> {
    await this.requireSession(opts);
    return this.repo.update(opts.tenantId, opts.sessionId, {
      status: opts.status,
      updatedAt: this.clock.nowMs(),
    });
  }

  /**
   * Run-history summary write (issue #21). Not wired to any public route —
   * production writes to these columns happen via
   * RuntimeAdapterImpl.endTurn/terminate (packages/session-runtime), which
   * talks to the `sessions` table directly on session completion and
   * doesn't depend on this service. This method exists so the fields are
   * reachable through the normal port/service layering too (tests,
   * potential future backfill/admin tooling) instead of only via raw SQL.
   */
  async recordRunSummary(opts: {
    tenantId: string;
    sessionId: string;
    stopReason?: string | null;
    toolCallCount?: number;
    messageCount?: number;
  }): Promise<SessionRow> {
    await this.requireSession(opts);
    const update: SessionUpdateFields = { updatedAt: this.clock.nowMs() };
    if (opts.stopReason !== undefined) update.stopReason = opts.stopReason;
    if (opts.toolCallCount !== undefined) update.toolCallCount = opts.toolCallCount;
    if (opts.messageCount !== undefined) update.messageCount = opts.messageCount;
    return this.repo.update(opts.tenantId, opts.sessionId, update);
  }

  async archive(opts: { tenantId: string; sessionId: string }): Promise<SessionRow> {
    await this.requireSession(opts);
    return this.repo.archive(opts.tenantId, opts.sessionId, this.clock.nowMs());
  }

  /**
   * Hard-delete the session + cascade its session_resources in one batch.
   * Caller is responsible for: secret KV cleanup, sandbox destroy, sidx
   * cleanup. Service stays out of those because they live in different
   * subsystems (KV, sandbox binding) and would tangle ports.
   */
  async delete(opts: { tenantId: string; sessionId: string }): Promise<void> {
    await this.requireSession(opts);
    await this.repo.deleteWithResources(opts.tenantId, opts.sessionId);
  }

  /**
   * Cascade-delete every session for an agent (and all their resources). Used
   * by the agent-delete safety path: callers should first call
   * `hasActiveByAgent` to refuse if any session is still active, then either
   * archive remaining sessions OR call this to wipe everything.
   *
   * Returns deletion count for logging.
   */
  async deleteByAgent(opts: { tenantId: string; agentId: string }): Promise<number> {
    return this.repo.deleteByAgent(opts.tenantId, opts.agentId);
  }

  // ============================================================
  // Read paths
  // ============================================================

  async get(opts: {
    tenantId: string;
    sessionId: string;
  }): Promise<SessionRow | null> {
    return this.repo.get(opts.tenantId, opts.sessionId);
  }

  /** Cross-tenant lookup by session id — replaces the `sidx:` reverse-index
   *  pattern in internal.ts:381-409. Returns the row including its tenant_id
   *  so internal endpoints can authorize downstream calls. */
  async getById(opts: { sessionId: string }): Promise<SessionRow | null> {
    return this.repo.getById(opts.sessionId);
  }

  async list(opts: {
    tenantId: string;
    agentId?: string;
    includeArchived?: boolean;
    order?: "asc" | "desc";
    limit?: number;
  }): Promise<SessionRow[]> {
    const listOpts: SessionListOptions = {
      agentId: opts.agentId,
      includeArchived: opts.includeArchived ?? false,
      order: opts.order ?? "desc",
      limit: opts.limit ?? 100,
    };
    return this.repo.list(opts.tenantId, listOpts);
  }

  /** Cursor-paginated list. Order: created_at DESC, id DESC tie-break.
   *  Optional `agentId` narrows to one agent's sessions. `status` filters by
   *  the session lifecycle column; `q` is a case-insensitive substring filter
   *  on title. */
  async listPage(opts: {
    tenantId: string;
    agentId?: string;
    includeArchived?: boolean;
    limit?: number;
    cursor?: string;
    status?: SessionStatus;
    q?: string;
    /** Inclusive lower bound on created_at (epoch ms). */
    createdAfter?: number;
    /** Exclusive upper bound on created_at (epoch ms). */
    createdBefore?: number;
  }): Promise<{ items: SessionRow[]; nextCursor?: string }> {
    return paginateVia({
      cursor: opts.cursor,
      limit: opts.limit,
      fetch: (after, limit) =>
        this.repo.listPage(opts.tenantId, {
          agentId: opts.agentId,
          includeArchived: opts.includeArchived ?? false,
          limit,
          after,
          status: opts.status,
          q: opts.q,
          createdAfter: opts.createdAfter,
          createdBefore: opts.createdBefore,
        }),
      extractCursor: (r) => ({
        createdAt: new Date(r.created_at).getTime(),
        id: r.id,
      }),
    });
  }

  /** Agent-delete safety check: refuse if any active session in the tenant
   *  references this agent. Replaces the agents.ts:340-348 KV list+filter. */
  async hasActiveByAgent(opts: {
    tenantId: string;
    agentId: string;
  }): Promise<boolean> {
    return this.repo.hasActiveByAgent(opts.tenantId, opts.agentId);
  }

  /** Environment-delete safety check — same shape as hasActiveByAgent. */
  async hasActiveByEnvironment(opts: {
    tenantId: string;
    environmentId: string;
  }): Promise<boolean> {
    return this.repo.hasActiveByEnvironment(opts.tenantId, opts.environmentId);
  }

  /** `max_sessions` concurrency-cap check for the agent-schedule cron tick
   *  (issue #165) — see {@link SessionRepo.countActiveByScheduleId}. */
  async countActiveByScheduleId(opts: {
    tenantId: string;
    scheduleId: string;
  }): Promise<number> {
    return this.repo.countActiveByScheduleId(opts.tenantId, opts.scheduleId);
  }

  /** Cheap COUNT for /v1/stats. Default counts only non-archived rows. */
  async count(opts: {
    tenantId: string;
    includeArchived?: boolean;
  }): Promise<number> {
    return this.repo.count(opts.tenantId, {
      includeArchived: opts.includeArchived ?? false,
    });
  }

  /**
   * Add a per-turn token delta to a session's cumulative counters. Called
   * from SessionDO's reportUsage hook (the same site that records
   * `usage_events`), so the session row's `input_tokens`/`output_tokens`
   * stay consistent with the durable usage ledger without a second
   * token-recording path. Fire-and-forget; a missing session is a no-op.
   */
  async addTokenUsage(opts: {
    tenantId: string;
    sessionId: string;
    inputTokens: number;
    outputTokens: number;
  }): Promise<void> {
    await this.repo.addTokenUsage(opts.tenantId, opts.sessionId, {
      inputTokens: opts.inputTokens,
      outputTokens: opts.outputTokens,
      updatedAt: this.clock.nowMs(),
    });
  }

  /**
   * Aggregated session analytics for the Observability tab. Scoped to a
   * tenant, optionally to one agent, over a rolling time range. Fetches the
   * projected session rows in range and computes every aggregate in JS (see
   * {@link computeSessionAnalytics}) — no dialect-specific SQL, so it behaves
   * identically on D1 and Postgres. `now` is injectable for deterministic tests.
   */
  async analytics(opts: {
    tenantId: string;
    agentId?: string;
    range?: string;
    now?: number;
  }): Promise<SessionAnalytics> {
    const now = opts.now ?? this.clock.nowMs();
    const { range, days } = normalizeRange(opts.range);
    const endMs = now;
    const startMs = endMs - days * DAY_MS;
    const rows = await this.repo.listForAnalytics(opts.tenantId, {
      agentId: opts.agentId,
      startMs,
      endMs,
    });
    return computeSessionAnalytics(rows, { range, startMs, endMs });
  }

  // ============================================================
  // Resource ops
  // ============================================================

  /**
   * Add a resource to an existing session. Enforces the per-session count cap
   * (100) and the memory_store sub-cap (8). Refuses on archived sessions
   * (consistency with the events route's archived-session block).
   */
  async addResource(opts: {
    tenantId: string;
    sessionId: string;
    resource: NewResourceInput;
  }): Promise<SessionResourceRow> {
    const session = await this.requireSession(opts);
    if (session.archived_at) throw new SessionArchivedError();

    const total = await this.repo.countResources(opts.sessionId);
    if (total >= MAX_RESOURCES_PER_SESSION) {
      throw new SessionResourceMaxExceededError(MAX_RESOURCES_PER_SESSION);
    }
    if (opts.resource.type === "memory_store") {
      const memCount = await this.repo.countResourcesByType(opts.sessionId, "memory_store");
      if (memCount >= MAX_MEMORY_STORE_RESOURCES_PER_SESSION) {
        throw new SessionMemoryStoreMaxExceededError(MAX_MEMORY_STORE_RESOURCES_PER_SESSION);
      }
    }
    const resourceId = this.ids.resourceId();
    const createdAt = this.clock.nowMs();
    return this.repo.insertResource({
      id: resourceId,
      sessionId: opts.sessionId,
      createdAt,
      resource: {
        ...(opts.resource as SessionResource),
        id: resourceId,
        session_id: opts.sessionId,
        created_at: new Date(createdAt).toISOString(),
      },
    });
  }

  async listResources(opts: {
    tenantId: string;
    sessionId: string;
  }): Promise<SessionResourceRow[]> {
    await this.requireSession(opts);
    return this.repo.listResources(opts.sessionId);
  }

  /**
   * Untenanted resource list — used by SessionDO at warmup, where the DO
   * already trusts its own state's tenant_id. Lets the DO skip the
   * session-existence round-trip when it just needs the resource snapshot.
   */
  async listResourcesBySession(opts: {
    sessionId: string;
  }): Promise<SessionResourceRow[]> {
    return this.repo.listResources(opts.sessionId);
  }

  async getResource(opts: {
    tenantId: string;
    sessionId: string;
    resourceId: string;
  }): Promise<SessionResourceRow | null> {
    await this.requireSession(opts);
    return this.repo.getResource(opts.sessionId, opts.resourceId);
  }

  async deleteResource(opts: {
    tenantId: string;
    sessionId: string;
    resourceId: string;
  }): Promise<void> {
    await this.requireSession(opts);
    const existing = await this.repo.getResource(opts.sessionId, opts.resourceId);
    if (!existing) throw new SessionResourceNotFoundError();
    await this.repo.deleteResource(opts.sessionId, opts.resourceId);
  }

  /** Replace the resource JSON column with the caller's body. AMA's
   *  POST /v1/sessions/:id/resources/:resource_id replaces the entire
   *  SessionResource shape; we re-stamp `id` / `session_id` / `created_at`
   *  on the caller's payload so identity stays stable. Sandbox-side
   *  remount (e.g. mount_path / access changes) is the caller's job —
   *  this method only persists. */
  async updateResource(opts: {
    tenantId: string;
    sessionId: string;
    resourceId: string;
    resource: SessionResource;
  }): Promise<SessionResourceRow> {
    await this.requireSession(opts);
    const existing = await this.repo.getResource(opts.sessionId, opts.resourceId);
    if (!existing) throw new SessionResourceNotFoundError();
    const stamped = {
      ...opts.resource,
      id: opts.resourceId,
      session_id: opts.sessionId,
      // Preserve the original created_at — AMA's update doesn't move
      // the creation timestamp.
      created_at: existing.resource.created_at ?? existing.created_at,
    } as SessionResource;
    return this.repo.updateResource(opts.sessionId, opts.resourceId, stamped);
  }

  /** Indexed COUNT for sessions.ts:853 quota check (called before a memory_store add). */
  async countActiveResources(opts: {
    sessionId: string;
  }): Promise<number> {
    return this.repo.countResources(opts.sessionId);
  }

  // ============================================================
  // Internals
  // ============================================================

  private async requireSession(opts: {
    tenantId: string;
    sessionId: string;
  }): Promise<SessionRow> {
    const row = await this.repo.get(opts.tenantId, opts.sessionId);
    if (!row) throw new SessionNotFoundError();
    return row;
  }
}

// ============================================================
// Helpers
// ============================================================

/**
 * Per-key merge: pass `{ a: 1, b: null }` to set `a=1` and delete `b`. Mirrors
 * the legacy KV behavior in sessions.ts:489-498. `existing` may be null (no
 * prior metadata) — treated as an empty object.
 */
function mergeMetadata(
  existing: Record<string, unknown> | null,
  patch: Record<string, unknown>,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = { ...(existing ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete out[key];
    } else {
      out[key] = value;
    }
  }
  return Object.keys(out).length === 0 ? null : out;
}

// ============================================================
// Default infra
// ============================================================

const defaultClock: Clock = { nowMs: () => Date.now() };

const defaultIds: IdGenerator = {
  sessionId: generateSessionId,
  resourceId: generateResourceId,
};

const consoleLogger: Logger = { warn: (msg, ctx) => console.warn(msg, ctx) };

// ============================================================
// Analytics
// ============================================================

const DAY_MS = 86_400_000;

/** Allowed analytics ranges → window length in days. Default 30d. */
const RANGE_DAYS: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90 };

/** Normalize a range param to a canonical `{ range, days }`. Unknown/blank
 *  falls back to 30d — routes zod-validate first, this is the belt-and-braces. */
export function normalizeRange(range?: string): { range: string; days: number } {
  const key = range && range in RANGE_DAYS ? range : "30d";
  return { range: key, days: RANGE_DAYS[key] };
}

/** Nearest-rank percentile (p in 0..100) over an unsorted numeric array.
 *  Empty array → 0. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(Math.max(rank, 1), sorted.length) - 1;
  return sorted[idx];
}

function percentiles(values: number[]): Percentiles {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
  };
}

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Pure aggregation over projected session rows. Kept side-effect-free and
 * exported so it can be unit-tested without a repo. See {@link SessionAnalytics}
 * for the error-rate definition and the tool_usage/stop_reasons availability
 * notes.
 */
export function computeSessionAnalytics(
  rows: AnalyticsSessionRow[],
  opts: { range: string; startMs: number; endMs: number },
): SessionAnalytics {
  const inputPer: number[] = [];
  const outputPer: number[] = [];
  const totalPer: number[] = [];
  const turnsPer: number[] = [];
  const dayCounts = new Map<string, number>();
  const stopCounts = new Map<string, number>();

  let inputTotal = 0;
  let outputTotal = 0;
  let toolCalls = 0;
  let turnsTotal = 0;
  let completed = 0;
  let errors = 0;

  for (const r of rows) {
    inputTotal += r.input_tokens;
    outputTotal += r.output_tokens;
    toolCalls += r.tool_call_count;
    turnsTotal += r.message_count;
    inputPer.push(r.input_tokens);
    outputPer.push(r.output_tokens);
    totalPer.push(r.input_tokens + r.output_tokens);
    turnsPer.push(r.message_count);

    const day = utcDate(r.created_at);
    dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1);

    if (r.stop_reason !== null) {
      completed++;
      stopCounts.set(r.stop_reason, (stopCounts.get(r.stop_reason) ?? 0) + 1);
      // "destroyed" is the only abnormal-termination signal persisted in the
      // control plane (see SessionAnalytics doc). "end_turn"/"terminated" are
      // normal. True harness errors live in the DO event log, not queryable
      // cross-session, so they are not counted here.
      if (r.stop_reason === "destroyed") errors++;
    }
  }

  // Dense daily buckets across the whole range (incl. zero-count days).
  const seriesStart = Date.UTC(
    new Date(opts.startMs).getUTCFullYear(),
    new Date(opts.startMs).getUTCMonth(),
    new Date(opts.startMs).getUTCDate(),
  );
  const sessions_over_time: Array<{ date: string; count: number }> = [];
  for (let d = seriesStart; d <= opts.endMs; d += DAY_MS) {
    const date = utcDate(d);
    sessions_over_time.push({ date, count: dayCounts.get(date) ?? 0 });
  }

  const stop_reasons = Array.from(stopCounts.entries())
    .map(([stop_reason, count]) => ({ stop_reason, count }))
    .sort((a, b) => b.count - a.count);

  return {
    range: opts.range,
    start: new Date(opts.startMs).toISOString(),
    end: new Date(opts.endMs).toISOString(),
    total_sessions: rows.length,
    completed_sessions: completed,
    error_count: errors,
    error_rate: completed > 0 ? errors / completed : 0,
    tokens: {
      input: inputTotal,
      output: outputTotal,
      total: inputTotal + outputTotal,
      per_session: {
        input: percentiles(inputPer),
        output: percentiles(outputPer),
        total: percentiles(totalPer),
      },
    },
    total_turns: turnsTotal,
    turns_per_session: percentiles(turnsPer),
    total_tool_calls: toolCalls,
    sessions_over_time,
    stop_reasons,
  };
}
