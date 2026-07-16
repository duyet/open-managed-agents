// Published agents (CF SQLite / D1).
//
// A published agent is a keystone primitive: a stable public slug that
// exposes an agent to anonymous end-users via the /p/:slug public chat
// surface (issue #72). Publication rows live on the shared control-plane
// D1 with row-level tenant_id isolation (no per-tenant shard) — consistent
// with every other table in this barrel + packages/tenant-db.
//
// The agent_version is pinned at create time so public sessions always bind
// to the exact version the creator published (the sessions store already
// binds a session to an agent+version at create time).
//
// Source: spec in GitHub issue #72.

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const agent_publication = sqliteTable(
  "agent_publication",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    agent_id: text("agent_id").notNull(),
    agent_version: integer("agent_version").notNull(),
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
    created_at: integer("created_at").notNull(),
  },
  (t) => [
    index("idx_agent_publication_tenant").on(t.tenant_id),
    index("idx_agent_publication_slug").on(t.slug),
    index("idx_agent_publication_agent").on(t.tenant_id, t.agent_id),
    index("idx_agent_publication_tenant_created_id").on(t.tenant_id, t.created_at, t.id),
  ],
);
