// In-memory implementations of every port for unit tests.

import type { PageCursor } from "@duyet/oma-shared";
import {
  NewPublicationInput,
  PublicationRepo,
  PublicationUpdateFields,
} from "./ports";
import type { PublicationRow } from "./types";
import { PublicationService } from "./service";

interface InMemPublication {
  id: string;
  tenant_id: string;
  agent_id: string;
  agent_version: number;
  slug: string;
  title: string;
  description: string | null;
  avatar_url: string | null;
  visibility: PublicationRow["visibility"];
  status: PublicationRow["status"];
  greeting: string | null;
  suggested_prompts: string[];
  pricing_ref: string | null;
  rate_limit_ref: string | null;
  environment_id: string | null;
  created_at: number;
}

export class InMemoryPublicationRepo implements PublicationRepo {
  private readonly byId = new Map<string, InMemPublication>();
  private readonly bySlug = new Map<string, InMemPublication>();

  private checkSlugConflict(slug: string, exceptId?: string): void {
    const existing = this.bySlug.get(slug);
    if (existing && existing.id !== exceptId) {
      const err = new Error(`UNIQUE constraint failed: agent_publication.slug`);
      throw err;
    }
  }

  async insert(input: NewPublicationInput): Promise<PublicationRow> {
    this.checkSlugConflict(input.slug);
    const row: InMemPublication = {
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
      suggested_prompts: input.suggestedPrompts ?? [],
      pricing_ref: input.pricingRef,
      rate_limit_ref: input.rateLimitRef,
      environment_id: input.environmentId,
      created_at: input.createdAt,
    };
    this.byId.set(input.id, row);
    this.bySlug.set(input.slug, row);
    return toRow(row);
  }

  async get(tenantId: string, id: string): Promise<PublicationRow | null> {
    const row = this.byId.get(id);
    if (!row || row.tenant_id !== tenantId) return null;
    return toRow(row);
  }

  async getBySlug(slug: string): Promise<PublicationRow | null> {
    const row = this.bySlug.get(slug);
    return row ? toRow(row) : null;
  }

  async list(
    tenantId: string,
    opts: { agentId?: string },
  ): Promise<PublicationRow[]> {
    return Array.from(this.byId.values())
      .filter((r) => r.tenant_id === tenantId)
      .filter((r) => (opts.agentId ? r.agent_id === opts.agentId : true))
      .sort((a, b) => b.created_at - a.created_at)
      .map(toRow);
  }

  async listPage(
    tenantId: string,
    opts: {
      agentId?: string;
      limit: number;
      after?: PageCursor;
    },
  ): Promise<{ items: PublicationRow[]; hasMore: boolean }> {
    let rows = Array.from(this.byId.values())
      .filter((r) => r.tenant_id === tenantId)
      .filter((r) => (opts.agentId ? r.agent_id === opts.agentId : true))
      .sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id));
    if (opts.after) {
      const { createdAt: t, id } = opts.after;
      rows = rows.filter((r) => r.created_at < t || (r.created_at === t && r.id < id));
    }
    const hasMore = rows.length > opts.limit;
    return {
      items: (hasMore ? rows.slice(0, opts.limit) : rows).map(toRow),
      hasMore,
    };
  }

  async update(
    tenantId: string,
    id: string,
    fields: PublicationUpdateFields,
  ): Promise<PublicationRow> {
    const row = this.byId.get(id);
    if (!row || row.tenant_id !== tenantId) {
      throw new Error("publication not found");
    }
    if (fields.slug !== undefined && fields.slug !== row.slug) {
      this.checkSlugConflict(fields.slug, id);
      this.bySlug.delete(row.slug);
      row.slug = fields.slug;
      this.bySlug.set(fields.slug, row);
    }
    if (fields.title !== undefined) row.title = fields.title;
    if (fields.description !== undefined) row.description = fields.description;
    if (fields.avatarUrl !== undefined) row.avatar_url = fields.avatarUrl;
    if (fields.visibility !== undefined) row.visibility = fields.visibility;
    if (fields.status !== undefined) row.status = fields.status;
    if (fields.greeting !== undefined) row.greeting = fields.greeting;
    if (fields.suggestedPrompts !== undefined) row.suggested_prompts = fields.suggestedPrompts;
    if (fields.pricingRef !== undefined) row.pricing_ref = fields.pricingRef;
    if (fields.rateLimitRef !== undefined) row.rate_limit_ref = fields.rateLimitRef;
    if (fields.environmentId !== undefined) row.environment_id = fields.environmentId;
    return toRow(row);
  }

  async delete(tenantId: string, id: string): Promise<void> {
    const row = this.byId.get(id);
    if (!row || row.tenant_id !== tenantId) return;
    this.byId.delete(id);
    this.bySlug.delete(row.slug);
  }
}

export class SequentialPublicationIdGenerator {
  private n = 0;
  publicationId(): string {
    return `pub-${++this.n}`;
  }
  slug(): string {
    return `slug-${++this.n}`;
  }
}

/**
 * Convenience factory — full in-memory wiring with sane defaults.
 */
export function createInMemoryPublicationService(opts?: {
  clock?: import("./ports").Clock;
  ids?: import("./ports").IdGenerator;
  logger?: import("./ports").Logger;
}): {
  service: PublicationService;
  repo: InMemoryPublicationRepo;
} {
  const repo = new InMemoryPublicationRepo();
  const service = new PublicationService({
    repo,
    clock: opts?.clock,
    ids: opts?.ids ?? new SequentialPublicationIdGenerator(),
    logger: opts?.logger,
  });
  return { service, repo };
}

function toRow(a: InMemPublication): PublicationRow {
  return {
    id: a.id,
    tenant_id: a.tenant_id,
    agent_id: a.agent_id,
    agent_version: a.agent_version,
    slug: a.slug,
    title: a.title,
    description: a.description,
    avatar_url: a.avatar_url,
    visibility: a.visibility,
    status: a.status,
    greeting: a.greeting,
    suggested_prompts: a.suggested_prompts,
    pricing_ref: a.pricing_ref,
    rate_limit_ref: a.rate_limit_ref,
    environment_id: a.environment_id,
    created_at: msToIso(a.created_at),
  };
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}
