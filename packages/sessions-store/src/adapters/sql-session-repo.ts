import { and, asc, desc, eq, gte, inArray, isNull, like, lt, or, sql } from "drizzle-orm";
import {
  asBuilder,
  atomicWrite,
  getAll,
  getOne,
  type OmaDb,
  type OmaDbBuilder,
  runOnce,
} from "@duyet/oma-db-schema";
import {
  session_resources,
  sessions,
} from "@duyet/oma-db-schema/cf-auth";
import type {
  AgentConfig,
  EnvironmentConfig,
  PageCursor,
  SessionResource,
  SessionStatus,
} from "@duyet/oma-shared";
import { escapeLikePattern, fetchN, trimPage } from "@duyet/oma-shared";
import { SessionNotFoundError } from "../errors";
import type {
  NewSessionInput,
  NewSessionResourceInput,
  SessionListOptions,
  SessionRepo,
  SessionUpdateFields,
} from "../ports";
import type { AnalyticsSessionRow, SessionResourceRow, SessionRow } from "../types";


/**
 * Drizzle implementation of {@link SessionRepo}. Owns the SQL against the
 * `sessions` and `session_resources` tables.
 *
 * Atomicity:
 *   - insertWithResources batches a session row + N resource rows so they
 *     succeed-or-fail together (D1 batch on CF, transaction on PG).
 *   - deleteWithResources / deleteByAgent batch the cascade deletes.
 */
export class SqlSessionRepo implements SessionRepo {
  private readonly db: OmaDbBuilder;
  constructor(db: OmaDb) {
    this.db = asBuilder(db);
  }

  async insertWithResources(
    session: NewSessionInput,
    resources: NewSessionResourceInput[],
  ): Promise<{ session: SessionRow; resources: SessionResourceRow[] }> {
    const insertSessionQ = this.db.insert(sessions).values({
      id: session.id,
      tenant_id: session.tenantId,
      agent_id: session.agentId,
      environment_id: session.environmentId,
      title: session.title,
      status: session.status,
      vault_ids: session.vaultIds !== null ? JSON.stringify(session.vaultIds) : null,
      agent_snapshot:
        session.agentSnapshot !== null ? JSON.stringify(session.agentSnapshot) : null,
      environment_snapshot:
        session.environmentSnapshot !== null
          ? JSON.stringify(session.environmentSnapshot)
          : null,
      metadata: session.metadata !== null ? JSON.stringify(session.metadata) : null,
      created_at: session.createdAt,
    });
    const queries: unknown[] = [insertSessionQ];
    for (const r of resources) {
      queries.push(resourceInsertQuery(this.db, r));
    }
    await atomicWrite(this.db, queries);

    const inserted = await this.get(session.tenantId, session.id);
    if (!inserted) throw new Error("session vanished after insertWithResources");
    const insertedResources = resources.length
      ? await this.listResources(session.id)
      : [];
    return { session: inserted, resources: insertedResources };
  }

  async get(tenantId: string, sessionId: string): Promise<SessionRow | null> {
    const row = await getOne<typeof sessions.$inferSelect>(
      this.db
        .select()
        .from(sessions)
        .where(and(eq(sessions.id, sessionId), eq(sessions.tenant_id, tenantId))),
    );
    return row ? toSessionRow(row) : null;
  }

  async getById(sessionId: string): Promise<SessionRow | null> {
    const row = await getOne<typeof sessions.$inferSelect>(
      this.db.select().from(sessions).where(eq(sessions.id, sessionId)),
    );
    return row ? toSessionRow(row) : null;
  }

  async list(tenantId: string, opts: SessionListOptions): Promise<SessionRow[]> {
    const conds = [eq(sessions.tenant_id, tenantId)];
    if (opts.agentId) conds.push(eq(sessions.agent_id, opts.agentId));
    if (!opts.includeArchived) conds.push(isNull(sessions.archived_at));
    const orderColumn =
      opts.order === "asc" ? asc(sessions.created_at) : desc(sessions.created_at);
    const rows = await getAll<typeof sessions.$inferSelect>(
      this.db
        .select()
        .from(sessions)
        .where(and(...conds))
        .orderBy(orderColumn)
        .limit(opts.limit),
    );
    return rows.map(toSessionRow);
  }

  async listPage(
    tenantId: string,
    opts: {
      agentId?: string;
      includeArchived: boolean;
      limit: number;
      after?: PageCursor;
      status?: SessionStatus;
      q?: string;
      createdAfter?: number;
      createdBefore?: number;
    },
  ): Promise<{ items: SessionRow[]; hasMore: boolean }> {
    const conds = [eq(sessions.tenant_id, tenantId)];
    if (opts.agentId) conds.push(eq(sessions.agent_id, opts.agentId));
    if (!opts.includeArchived) conds.push(isNull(sessions.archived_at));
    if (opts.status) conds.push(eq(sessions.status, opts.status));
    if (opts.createdAfter !== undefined)
      conds.push(gte(sessions.created_at, opts.createdAfter));
    if (opts.createdBefore !== undefined)
      conds.push(lt(sessions.created_at, opts.createdBefore));
    if (opts.q) {
      // title is a regular TEXT column, no json_extract needed. SQLite LIKE
      // is ASCII-case-insensitive; ESCAPE '\' keeps any user-supplied %/_
      // literal (see escapeLikePattern).
      const pattern = `%${escapeLikePattern(opts.q)}%`;
      conds.push(like(sessions.title, pattern));
    }
    if (opts.after) {
      const c = opts.after;
      conds.push(
        or(
          lt(sessions.created_at, c.createdAt),
          and(eq(sessions.created_at, c.createdAt), lt(sessions.id, c.id))!,
        )!,
      );
    }
    const rows = await getAll<typeof sessions.$inferSelect>(
      this.db
        .select()
        .from(sessions)
        .where(and(...conds))
        .orderBy(desc(sessions.created_at), desc(sessions.id))
        .limit(fetchN(opts.limit)),
    );
    return trimPage(rows.map(toSessionRow), opts.limit);
  }

  async listForAnalytics(
    tenantId: string,
    opts: { agentId?: string; startMs: number; endMs: number },
  ): Promise<AnalyticsSessionRow[]> {
    const conds = [
      eq(sessions.tenant_id, tenantId),
      gte(sessions.created_at, opts.startMs),
      lt(sessions.created_at, opts.endMs),
    ];
    if (opts.agentId) conds.push(eq(sessions.agent_id, opts.agentId));
    const rows = await getAll<{
      created_at: number;
      input_tokens: number;
      output_tokens: number;
      tool_call_count: number;
      message_count: number;
      stop_reason: string | null;
    }>(
      this.db
        .select({
          created_at: sessions.created_at,
          input_tokens: sessions.input_tokens,
          output_tokens: sessions.output_tokens,
          tool_call_count: sessions.tool_call_count,
          message_count: sessions.message_count,
          stop_reason: sessions.stop_reason,
        })
        .from(sessions)
        .where(and(...conds)),
    );
    return rows.map((r) => ({
      created_at: r.created_at,
      input_tokens: r.input_tokens,
      output_tokens: r.output_tokens,
      tool_call_count: r.tool_call_count,
      message_count: r.message_count,
      stop_reason: r.stop_reason,
    }));
  }

  async addTokenUsage(
    tenantId: string,
    sessionId: string,
    delta: { inputTokens: number; outputTokens: number; updatedAt: number },
  ): Promise<void> {
    const input = delta.inputTokens > 0 ? Math.floor(delta.inputTokens) : 0;
    const output = delta.outputTokens > 0 ? Math.floor(delta.outputTokens) : 0;
    if (input === 0 && output === 0) return;
    await runOnce(
      this.db
        .update(sessions)
        .set({
          input_tokens: sql`${sessions.input_tokens} + ${input}`,
          output_tokens: sql`${sessions.output_tokens} + ${output}`,
          updated_at: delta.updatedAt,
        })
        .where(and(eq(sessions.id, sessionId), eq(sessions.tenant_id, tenantId))),
    );
  }

  async hasActiveByAgent(tenantId: string, agentId: string): Promise<boolean> {
    const row = await getOne<{ one: number }>(
      this.db
        .select({ one: sql<number>`1` })
        .from(sessions)
        .where(
          and(
            eq(sessions.tenant_id, tenantId),
            eq(sessions.agent_id, agentId),
            isNull(sessions.archived_at),
          ),
        )
        .limit(1),
    );
    return !!row;
  }

  async hasActiveByEnvironment(
    tenantId: string,
    environmentId: string,
  ): Promise<boolean> {
    const row = await getOne<{ one: number }>(
      this.db
        .select({ one: sql<number>`1` })
        .from(sessions)
        .where(
          and(
            eq(sessions.tenant_id, tenantId),
            eq(sessions.environment_id, environmentId),
            isNull(sessions.archived_at),
          ),
        )
        .limit(1),
    );
    return !!row;
  }

  async count(
    tenantId: string,
    opts: { includeArchived: boolean },
  ): Promise<number> {
    const conds = [eq(sessions.tenant_id, tenantId)];
    if (!opts.includeArchived) conds.push(isNull(sessions.archived_at));
    const row = await getOne<{ c: number }>(
      this.db
        .select({ c: sql<number>`COUNT(*)` })
        .from(sessions)
        .where(and(...conds)),
    );
    return row?.c ?? 0;
  }

  async update(
    tenantId: string,
    sessionId: string,
    update: SessionUpdateFields,
  ): Promise<SessionRow> {
    const set: Record<string, unknown> = { updated_at: update.updatedAt };
    if (update.title !== undefined) set.title = update.title;
    if (update.status !== undefined) set.status = update.status;
    if (update.metadata !== undefined) {
      set.metadata = update.metadata !== null ? JSON.stringify(update.metadata) : null;
    }
    if (update.agentSnapshot !== undefined) {
      set.agent_snapshot =
        update.agentSnapshot !== null ? JSON.stringify(update.agentSnapshot) : null;
    }
    if (update.environmentSnapshot !== undefined) {
      set.environment_snapshot =
        update.environmentSnapshot !== null
          ? JSON.stringify(update.environmentSnapshot)
          : null;
    }
    if (update.stopReason !== undefined) set.stop_reason = update.stopReason;
    if (update.toolCallCount !== undefined) set.tool_call_count = update.toolCallCount;
    if (update.messageCount !== undefined) set.message_count = update.messageCount;
    if (update.inputTokens !== undefined) set.input_tokens = update.inputTokens;
    if (update.outputTokens !== undefined) set.output_tokens = update.outputTokens;
    await runOnce(
      this.db
        .update(sessions)
        .set(set)
        .where(and(eq(sessions.id, sessionId), eq(sessions.tenant_id, tenantId))),
    );
    const row = await this.get(tenantId, sessionId);
    if (!row) throw new SessionNotFoundError();
    return row;
  }

  async archive(
    tenantId: string,
    sessionId: string,
    archivedAt: number,
  ): Promise<SessionRow> {
    await runOnce(
      this.db
        .update(sessions)
        .set({ archived_at: archivedAt, updated_at: archivedAt })
        .where(and(eq(sessions.id, sessionId), eq(sessions.tenant_id, tenantId))),
    );
    const row = await this.get(tenantId, sessionId);
    if (!row) throw new SessionNotFoundError();
    return row;
  }

  async deleteWithResources(tenantId: string, sessionId: string): Promise<void> {
    // Two-statement batch: drop resources first then the session row.
    const deleteResourcesQ = this.db
      .delete(session_resources)
      .where(eq(session_resources.session_id, sessionId));
    const deleteSessionQ = this.db
      .delete(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.tenant_id, tenantId)));
    await atomicWrite(this.db, [deleteResourcesQ, deleteSessionQ]);
  }

  async deleteByAgent(tenantId: string, agentId: string): Promise<number> {
    // Discover session ids first so the resource cascade hits the right rows
    // and so the caller gets a deletion count.
    const ids = await getAll<{ id: string }>(
      this.db
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.tenant_id, tenantId), eq(sessions.agent_id, agentId))),
    );
    const sessionIds = ids.map((r) => r.id);
    if (!sessionIds.length) return 0;

    const deleteResourcesQ = this.db
      .delete(session_resources)
      .where(inArray(session_resources.session_id, sessionIds));
    const deleteSessionsQ = this.db
      .delete(sessions)
      .where(and(eq(sessions.tenant_id, tenantId), eq(sessions.agent_id, agentId)));
    await atomicWrite(this.db, [deleteResourcesQ, deleteSessionsQ]);
    return sessionIds.length;
  }

  // ── resource ops ──

  async insertResource(input: NewSessionResourceInput): Promise<SessionResourceRow> {
    await runOnce(resourceInsertQuery(this.db, input) as PromiseLike<unknown>);
    const row = await this.getResource(input.sessionId, input.id);
    if (!row) throw new Error("resource vanished after insert");
    return row;
  }

  async getResource(
    sessionId: string,
    resourceId: string,
  ): Promise<SessionResourceRow | null> {
    const row = await getOne<typeof session_resources.$inferSelect>(
      this.db
        .select()
        .from(session_resources)
        .where(
          and(
            eq(session_resources.id, resourceId),
            eq(session_resources.session_id, sessionId),
          ),
        ),
    );
    return row ? toResourceRow(row) : null;
  }

  async listResources(sessionId: string): Promise<SessionResourceRow[]> {
    const rows = await getAll<typeof session_resources.$inferSelect>(
      this.db
        .select()
        .from(session_resources)
        .where(eq(session_resources.session_id, sessionId))
        .orderBy(asc(session_resources.created_at)),
    );
    return rows.map(toResourceRow);
  }

  async countResources(sessionId: string): Promise<number> {
    const row = await getOne<{ c: number }>(
      this.db
        .select({ c: sql<number>`COUNT(*)` })
        .from(session_resources)
        .where(eq(session_resources.session_id, sessionId)),
    );
    return row?.c ?? 0;
  }

  async countResourcesByType(
    sessionId: string,
    type: SessionResource["type"],
  ): Promise<number> {
    const row = await getOne<{ c: number }>(
      this.db
        .select({ c: sql<number>`COUNT(*)` })
        .from(session_resources)
        .where(
          and(
            eq(session_resources.session_id, sessionId),
            eq(session_resources.type, type),
          ),
        ),
    );
    return row?.c ?? 0;
  }

  async deleteResource(sessionId: string, resourceId: string): Promise<void> {
    await runOnce(
      this.db
        .delete(session_resources)
        .where(
          and(
            eq(session_resources.id, resourceId),
            eq(session_resources.session_id, sessionId),
          ),
        ),
    );
  }

  async updateResource(
    sessionId: string,
    resourceId: string,
    resource: SessionResource,
  ): Promise<SessionResourceRow> {
    await runOnce(
      this.db
        .update(session_resources)
        .set({ config: JSON.stringify(resource) })
        .where(
          and(
            eq(session_resources.id, resourceId),
            eq(session_resources.session_id, sessionId),
          ),
        ),
    );
    const row = await this.getResource(sessionId, resourceId);
    if (!row) throw new Error(`session_resources ${resourceId} vanished after update`);
    return row;
  }

  async deleteAllResourcesForSession(sessionId: string): Promise<void> {
    await runOnce(
      this.db
        .delete(session_resources)
        .where(eq(session_resources.session_id, sessionId)),
    );
  }
}

function resourceInsertQuery(db: OmaDbBuilder, r: NewSessionResourceInput) {
  return db.insert(session_resources).values({
    id: r.id,
    session_id: r.sessionId,
    type: r.resource.type,
    config: JSON.stringify(r.resource),
    created_at: r.createdAt,
  });
}

function toSessionRow(r: typeof sessions.$inferSelect): SessionRow {
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    agent_id: r.agent_id,
    environment_id: r.environment_id,
    title: r.title,
    status: r.status as SessionStatus,
    vault_ids: r.vault_ids !== null ? (JSON.parse(r.vault_ids) as string[]) : null,
    agent_snapshot:
      r.agent_snapshot !== null ? (JSON.parse(r.agent_snapshot) as AgentConfig) : null,
    environment_snapshot:
      r.environment_snapshot !== null
        ? (JSON.parse(r.environment_snapshot) as EnvironmentConfig)
        : null,
    metadata:
      r.metadata !== null
        ? (JSON.parse(r.metadata) as Record<string, unknown>)
        : null,
    created_at: msToIso(r.created_at),
    updated_at: r.updated_at !== null ? msToIso(r.updated_at) : null,
    archived_at: r.archived_at !== null ? msToIso(r.archived_at) : null,
    terminated_at: r.terminated_at !== null ? msToIso(r.terminated_at) : null,
    stop_reason: r.stop_reason,
    tool_call_count: r.tool_call_count,
    message_count: r.message_count,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
  };
}

function toResourceRow(r: typeof session_resources.$inferSelect): SessionResourceRow {
  const parsed = JSON.parse(r.config) as SessionResource;
  return {
    id: r.id,
    session_id: r.session_id,
    type: r.type as SessionResource["type"],
    resource: parsed,
    created_at: msToIso(r.created_at),
  };
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}
