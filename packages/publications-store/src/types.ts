// Public types for the publications store service.

import type { PageCursor } from "@duyet/oma-shared";

/** Visibility governs who can reach a publication's public slug. */
export type PublicationVisibility = "public" | "unlisted" | "private";

/** Lifecycle state. Drives the anti-abuse floor before consumer auth (#2). */
export type PublicationStatus = "draft" | "live" | "paused";

/** Current-state publication row. JSON columns (suggested_prompts) are
 *  parsed in the adapter + surfaced as typed members here. */
export interface PublicationRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  agent_version: number;
  slug: string;
  title: string;
  description: string | null;
  avatar_url: string | null;
  visibility: PublicationVisibility;
  status: PublicationStatus;
  greeting: string | null;
  /** Parsed JSON array of suggested prompt strings (may be empty). */
  suggested_prompts: string[];
  /** FK reference into the pricing table (issue #3); null until wired. */
  pricing_ref: string | null;
  /** FK reference into the rate-limit table; null until wired. */
  rate_limit_ref: string | null;
  /** ISO-8601 timestamp. */
  created_at: string;
}

export interface PublicationRepo {
  insert(input: NewPublicationInput): Promise<PublicationRow>;

  get(tenantId: string, id: string): Promise<PublicationRow | null>;

  /** Cross-tenant lookup by slug — used by the public route group to
   *  resolve {tenant_id, agent_id, agent_version} without tenant auth. */
  getBySlug(slug: string): Promise<PublicationRow | null>;

  list(
    tenantId: string,
    opts: { agentId?: string },
  ): Promise<PublicationRow[]>;

  listPage(
    tenantId: string,
    opts: {
      agentId?: string;
      limit: number;
      after?: PageCursor;
    },
  ): Promise<{ items: PublicationRow[]; hasMore: boolean }>;

  update(
    tenantId: string,
    id: string,
    fields: PublicationUpdateFields,
  ): Promise<PublicationRow>;

  delete(tenantId: string, id: string): Promise<void>;
}

export interface NewPublicationInput {
  id: string;
  tenantId: string;
  agentId: string;
  agentVersion: number;
  slug: string;
  title: string;
  description: string | null;
  avatarUrl: string | null;
  visibility: PublicationVisibility;
  status: PublicationStatus;
  greeting: string | null;
  suggestedPrompts: string[];
  pricingRef: string | null;
  rateLimitRef: string | null;
  createdAt: number;
}

export interface PublicationUpdateFields {
  title?: string;
  description?: string | null;
  avatarUrl?: string | null;
  visibility?: PublicationVisibility;
  status?: PublicationStatus;
  greeting?: string | null;
  suggestedPrompts?: string[];
  pricingRef?: string | null;
  rateLimitRef?: string | null;
  /** Slug may be changed by the owner; the unique index enforces global
   *  uniqueness. Left optional — most updates don't touch the slug. */
  slug?: string;
}

export interface Clock {
  nowMs(): number;
}

export interface IdGenerator {
  publicationId(): string;
  slug(): string;
}

export interface Logger {
  warn(msg: string, ctx?: unknown): void;
}
