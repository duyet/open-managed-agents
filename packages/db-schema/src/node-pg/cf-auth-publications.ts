// Published agents (Node-PG variant of cf-auth/publications).
//
// Same table as cf-auth/publications but with PG-typed columns (bigint
// for integer timestamps, text for everything else). Mirrors the
// agents / model-cards PG barrel divergence. See cf-auth/publications.ts
// for the column semantics + issue #72 spec.

import { bigint, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

export const agent_publication = pgTable(
  "agent_publication",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    agent_id: text("agent_id").notNull(),
    agent_version: bigint("agent_version", { mode: "number" }).notNull(),
    slug: text("slug").notNull(),
    title: text("title").notNull().default(""),
    description: text("description"),
    avatar_url: text("avatar_url"),
    visibility: text("visibility").notNull().default("public"),
    status: text("status").notNull().default("draft"),
    greeting: text("greeting"),
    suggested_prompts: text("suggested_prompts"),
    pricing_ref: text("pricing_ref"),
    rate_limit_ref: text("rate_limit_ref"),
    created_at: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("idx_agent_publication_tenant").on(t.tenant_id),
    uniqueIndex("idx_agent_publication_slug").on(t.slug),
    index("idx_agent_publication_agent").on(t.tenant_id, t.agent_id),
    index("idx_agent_publication_tenant_created").on(t.tenant_id, t.created_at),
  ],
);
