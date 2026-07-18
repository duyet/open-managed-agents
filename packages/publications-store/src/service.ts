import { paginateVia, generateId } from "@duyet/oma-shared";
import type { IdGenerator, Logger, Clock, PublicationRepo } from "./ports";
import type { PublicationRow } from "./types";
import { PublicationNotFoundError, PublicationSlugConflictError } from "./errors";

export interface PublicationServiceDeps {
  repo: PublicationRepo;
  clock?: Clock;
  ids?: IdGenerator;
  logger?: Logger;
}

/** Mutable subset for `update`. Only set fields are written. */
export interface UpdatePublicationInput {
  title?: string;
  description?: string | null;
  avatarUrl?: string | null;
  visibility?: "public" | "unlisted" | "private";
  status?: "draft" | "live" | "paused";
  greeting?: string | null;
  suggestedPrompts?: string[];
  pricingRef?: string | null;
  rateLimitRef?: string | null;
  environmentId?: string | null;
  slug?: string;
}

/** Input for create. id + created_at + default fields filled by the service. */
export interface NewPublicationInput {
  agentId: string;
  agentVersion: number;
  slug: string;
  title: string;
  description?: string | null;
  avatarUrl?: string | null;
  visibility?: "public" | "unlisted" | "private";
  status?: "draft" | "live" | "paused";
  greeting?: string | null;
  suggestedPrompts?: string[];
  pricingRef?: string | null;
  rateLimitRef?: string | null;
  environmentId?: string | null;
}

/** URL-safe slug alphabet — lowercased, no ambiguous chars. */
function urlSafeSlug(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export class PublicationService {
  private readonly repo: PublicationRepo;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly logger: Logger;

  constructor(deps: PublicationServiceDeps) {
    this.repo = deps.repo;
    this.clock = deps.clock ?? defaultClock;
    this.ids = deps.ids ?? defaultIds;
    this.logger = deps.logger ?? consoleLogger;
  }

  async create(opts: {
    tenantId: string;
    input: NewPublicationInput;
  }): Promise<PublicationRow> {
    const slug = urlSafeSlug(opts.input.slug);
    if (!slug) throw new Error("slug is required");
    const id = this.ids.publicationId();
    const nowMs = this.clock.nowMs();
    try {
      return await this.repo.insert({
        id,
        tenantId: opts.tenantId,
        agentId: opts.input.agentId,
        agentVersion: opts.input.agentVersion,
        slug,
        title: opts.input.title,
        description: opts.input.description ?? null,
        avatarUrl: opts.input.avatarUrl ?? null,
        visibility: opts.input.visibility ?? "public",
        status: opts.input.status ?? "draft",
        greeting: opts.input.greeting ?? null,
        suggestedPrompts: opts.input.suggestedPrompts ?? [],
        pricingRef: opts.input.pricingRef ?? null,
        rateLimitRef: opts.input.rateLimitRef ?? null,
        environmentId: opts.input.environmentId ?? null,
        createdAt: nowMs,
      });
    } catch (err) {
      if (isSlugConflict(err)) throw new PublicationSlugConflictError();
      throw err;
    }
  }

  async update(opts: {
    tenantId: string;
    id: string;
    input: UpdatePublicationInput;
  }): Promise<PublicationRow> {
    await this.requirePublication(opts);
    const fields: import("./ports").PublicationUpdateFields = {};
    if (opts.input.title !== undefined) fields.title = opts.input.title;
    if (opts.input.description !== undefined) fields.description = opts.input.description;
    if (opts.input.avatarUrl !== undefined) fields.avatarUrl = opts.input.avatarUrl;
    if (opts.input.visibility !== undefined) fields.visibility = opts.input.visibility;
    if (opts.input.status !== undefined) fields.status = opts.input.status;
    if (opts.input.greeting !== undefined) fields.greeting = opts.input.greeting;
    if (opts.input.suggestedPrompts !== undefined) fields.suggestedPrompts = opts.input.suggestedPrompts;
    if (opts.input.pricingRef !== undefined) fields.pricingRef = opts.input.pricingRef;
    if (opts.input.rateLimitRef !== undefined) fields.rateLimitRef = opts.input.rateLimitRef;
    if (opts.input.environmentId !== undefined) fields.environmentId = opts.input.environmentId;
    if (opts.input.slug !== undefined) {
      const slug = urlSafeSlug(opts.input.slug);
      if (!slug) throw new Error("slug is required");
      fields.slug = slug;
    }
    try {
      return await this.repo.update(opts.tenantId, opts.id, fields);
    } catch (err) {
      if (isSlugConflict(err)) throw new PublicationSlugConflictError();
      throw err;
    }
  }

  async delete(opts: { tenantId: string; id: string }): Promise<void> {
    await this.requirePublication(opts);
    await this.repo.delete(opts.tenantId, opts.id);
  }

  async get(opts: { tenantId: string; id: string }): Promise<PublicationRow | null> {
    return this.repo.get(opts.tenantId, opts.id);
  }

  /** Cross-tenant lookup by slug — no tenant scope. Returns null on miss. */
  async getBySlug(opts: { slug: string }): Promise<PublicationRow | null> {
    return this.repo.getBySlug(opts.slug);
  }

  async list(opts: {
    tenantId: string;
    agentId?: string;
  }): Promise<PublicationRow[]> {
    return this.repo.list(opts.tenantId, { agentId: opts.agentId });
  }

  async listPage(opts: {
    tenantId: string;
    agentId?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ items: PublicationRow[]; nextCursor?: string }> {
    return paginateVia({
      cursor: opts.cursor,
      limit: opts.limit,
      fetch: (after, limit) =>
        this.repo.listPage(opts.tenantId, {
          agentId: opts.agentId,
          limit,
          after,
        }),
      extractCursor: (r) => ({ createdAt: new Date(r.created_at).getTime(), id: r.id }),
    });
  }

  private async requirePublication(opts: {
    tenantId: string;
    id: string;
  }): Promise<PublicationRow> {
    const row = await this.repo.get(opts.tenantId, opts.id);
    if (!row) throw new PublicationNotFoundError();
    return row;
  }
}

function isSlugConflict(err: unknown): boolean {
  const text = errorText(err);
  return (
    /slug/i.test(text) &&
    /(UNIQUE constraint failed|SQLITE_CONSTRAINT|duplicate key|unique constraint|constraint failed)/i.test(
      text,
    )
  );
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    return `${err.name} ${err.message} ${cause ? errorText(cause) : ""}`;
  }
  return String(err);
}

const defaultClock: Clock = { nowMs: () => Date.now() };
const defaultIds: IdGenerator = {
  publicationId: () => `pub-${generateId()}`,
  slug: () => `pub-${generateId()}`,
};
const consoleLogger: Logger = { warn: (msg, ctx) => console.warn(msg, ctx) };
