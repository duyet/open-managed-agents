// Abstract ports the PublicationService depends on. Same DIP pattern as
// packages/agents-store/src/ports.ts. Keep these runtime-agnostic.
//
// Tenant routing: every method takes `tenantId` as the first argument. The
// public slug lookup (getBySlug) deliberately has NO tenant scope — the
// public /p/:slug route group resolves the owning tenant from the row.

import type { PageCursor } from "@duyet/oma-shared";
import type { PublicationRow } from "./types";

export interface NewPublicationInput {
  id: string;
  tenantId: string;
  agentId: string;
  agentVersion: number;
  slug: string;
  title: string;
  description: string | null;
  avatarUrl: string | null;
  visibility: "public" | "unlisted" | "private";
  status: "draft" | "live" | "paused";
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
  visibility?: "public" | "unlisted" | "private";
  status?: "draft" | "live" | "paused";
  greeting?: string | null;
  suggestedPrompts?: string[];
  pricingRef?: string | null;
  rateLimitRef?: string | null;
  slug?: string;
}

export interface PublicationRepo {
  insert(input: NewPublicationInput): Promise<PublicationRow>;

  get(tenantId: string, id: string): Promise<PublicationRow | null>;

  /** Cross-tenant lookup by slug. Returns null on miss. */
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
