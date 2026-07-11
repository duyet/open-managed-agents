import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import {
  asBuilder,
  getAll,
  getOne,
  type OmaDb,
  type OmaDbBuilder,
  runOnce,
} from "@duyet/oma-db-schema";
import { agent_publication } from "@duyet/oma-db-schema/cf-auth";
import type { PageCursor } from "@duyet/oma-shared";
import { fetchN, trimPage } from "@duyet/oma-shared";
import type {
  NewPublicationInput,
  PublicationRepo,
  PublicationUpdateFields,
} from "../ports";
import type { PublicationRow } from "../types";

/**
 * Drizzle implementation of {@link PublicationRepo}. Owns the SQL against the
 * `agent_publication` table. Backend-agnostic: takes an {@link OmaDb}
 * (Drizzle wrapper around D1 / better-sqlite3 / postgres-js).
 */
export class SqlPublicationRepo implements PublicationRepo {
  private readonly db: OmaDbBuilder;
  constructor(db: OmaDb) {
    this.db = asBuilder(db);
  }

  async insert(input: NewPublicationInput): Promise<PublicationRow> {
    await runOnce(
      this.db.insert(agent_publication).values({
        id: input.id,
        tenant_id: input.tenantId,
        agent_id: input.agentId,
        agent_version: input.agentVersion,
        slug: input.slug,
        title: input.title,
        description: input.description,
        avatar_url: input.avatarUrl,
        visibility: input.visibility,
        status: input.status,
        greeting: input.greeting,
        suggested_prompts: JSON.stringify(input.suggestedPrompts ?? []),
        pricing_ref: input.pricingRef,
        rate_limit_ref: input.rateLimitRef,
        created_at: input.createdAt,
      }),
    );
    const row = await this.get(input.tenantId, input.id);
    if (!row) throw new Error("publication vanished after insert");
    return row;
  }

  async get(tenantId: string, id: string): Promise<PublicationRow | null> {
    const row = await getOne<typeof agent_publication.$inferSelect>(
      this.db
        .select()
        .from(agent_publication)
        .where(and(eq(agent_publication.id, id), eq(agent_publication.tenant_id, tenantId))),
    );
    return row ? toRow(row) : null;
  }

  async getBySlug(slug: string): Promise<PublicationRow | null> {
    const row = await getOne<typeof agent_publication.$inferSelect>(
      this.db.select().from(agent_publication).where(eq(agent_publication.slug, slug)),
    );
    return row ? toRow(row) : null;
  }

  async list(
    tenantId: string,
    opts: { agentId?: string },
  ): Promise<PublicationRow[]> {
    const conds = [eq(agent_publication.tenant_id, tenantId)];
    if (opts.agentId) conds.push(eq(agent_publication.agent_id, opts.agentId));
    const rows = await getAll<typeof agent_publication.$inferSelect>(
      this.db
        .select()
        .from(agent_publication)
        .where(and(...conds))
        .orderBy(desc(agent_publication.created_at)),
    );
    return rows.map(toRow);
  }

  async listPage(
    tenantId: string,
    opts: {
      agentId?: string;
      limit: number;
      after?: PageCursor;
    },
  ): Promise<{ items: PublicationRow[]; hasMore: boolean }> {
    const conds = [eq(agent_publication.tenant_id, tenantId)];
    if (opts.agentId) conds.push(eq(agent_publication.agent_id, opts.agentId));
    if (opts.after) {
      const c = opts.after;
      conds.push(
        or(
          lt(agent_publication.created_at, c.createdAt),
          and(eq(agent_publication.created_at, c.createdAt), lt(agent_publication.id, c.id))!,
        )!,
      );
    }
    const rows = await getAll<typeof agent_publication.$inferSelect>(
      this.db
        .select()
        .from(agent_publication)
        .where(and(...conds))
        .orderBy(desc(agent_publication.created_at), desc(agent_publication.id))
        .limit(fetchN(opts.limit)),
    );
    return trimPage(rows.map(toRow), opts.limit);
  }

  async update(
    tenantId: string,
    id: string,
    fields: PublicationUpdateFields,
  ): Promise<PublicationRow> {
    const set: Record<string, unknown> = {};
    if (fields.title !== undefined) set.title = fields.title;
    if (fields.description !== undefined) set.description = fields.description;
    if (fields.avatarUrl !== undefined) set.avatar_url = fields.avatarUrl;
    if (fields.visibility !== undefined) set.visibility = fields.visibility;
    if (fields.status !== undefined) set.status = fields.status;
    if (fields.greeting !== undefined) set.greeting = fields.greeting;
    if (fields.suggestedPrompts !== undefined) {
      set.suggested_prompts = JSON.stringify(fields.suggestedPrompts);
    }
    if (fields.pricingRef !== undefined) set.pricing_ref = fields.pricingRef;
    if (fields.rateLimitRef !== undefined) set.rate_limit_ref = fields.rateLimitRef;
    if (fields.slug !== undefined) set.slug = fields.slug;
    await runOnce(
      this.db
        .update(agent_publication)
        .set(set)
        .where(and(eq(agent_publication.id, id), eq(agent_publication.tenant_id, tenantId))),
    );
    const row = await this.get(tenantId, id);
    if (!row) throw new Error("publication vanished after update");
    return row;
  }

  async delete(tenantId: string, id: string): Promise<void> {
    await runOnce(
      this.db
        .delete(agent_publication)
        .where(and(eq(agent_publication.id, id), eq(agent_publication.tenant_id, tenantId))),
    );
  }
}

function toRow(r: typeof agent_publication.$inferSelect): PublicationRow {
  let prompts: string[] = [];
  if (r.suggested_prompts) {
    try {
      const parsed = JSON.parse(r.suggested_prompts);
      if (Array.isArray(parsed)) prompts = parsed.map(String);
    } catch {
      prompts = [];
    }
  }
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    agent_id: r.agent_id,
    agent_version: r.agent_version,
    slug: r.slug,
    title: r.title,
    description: r.description ?? null,
    avatar_url: r.avatar_url ?? null,
    visibility: r.visibility as PublicationRow["visibility"],
    status: r.status as PublicationRow["status"],
    greeting: r.greeting ?? null,
    suggested_prompts: prompts,
    pricing_ref: r.pricing_ref ?? null,
    rate_limit_ref: r.rate_limit_ref ?? null,
    created_at: msToIso(r.created_at),
  };
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}
