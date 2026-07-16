// Consumer (end-user) realm + per-publication pricing — Node self-host PG
// variant of node-sqlite/consumers (issue #226).
//
// Same tables as node-sqlite/consumers, PG-typed: TEXT for text + ISO-8601
// timestamps, BIGINT for the 0/1 `used` flag and integer credit amounts
// (matching the node-pg "integers are bigint" convention). See
// node-sqlite/consumers.ts for column semantics + the CF migration provenance.
//
// Node-only ON PURPOSE — not mirrored into cf-auth (CF ships these as
// hand-written SQL migrations 0020-0022).

import { bigint, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

export const consumers = pgTable("consumers", {
  id: text("id").primaryKey().notNull(),
  email: text("email").notNull().unique(),
  name: text("name").notNull().default(""),
  auth_provider: text("auth_provider").notNull().default("email_otp"),
  tenant_id: text("tenant_id"),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
});

export const magic_links = pgTable(
  "magic_links",
  {
    token: text("token").primaryKey().notNull(),
    consumer_id: text("consumer_id").notNull(),
    expires_at: text("expires_at").notNull(),
    used: bigint("used", { mode: "number" }).notNull().default(0),
    created_at: text("created_at").notNull(),
  },
  (t) => [index("idx_magic_links_consumer").on(t.consumer_id)],
);

export const consumer_sessions = pgTable(
  "consumer_sessions",
  {
    token: text("token").primaryKey().notNull(),
    consumer_id: text("consumer_id").notNull(),
    expires_at: text("expires_at").notNull(),
    created_at: text("created_at").notNull(),
  },
  (t) => [index("idx_consumer_sessions_consumer").on(t.consumer_id)],
);

export const consumer_publications = pgTable(
  "consumer_publications",
  {
    id: text("id").primaryKey().notNull(),
    consumer_id: text("consumer_id").notNull(),
    publication_id: text("publication_id").notNull(),
    tenant_id: text("tenant_id").notNull(),
    first_seen_at: text("first_seen_at").notNull(),
    last_seen_at: text("last_seen_at").notNull(),
  },
  (t) => [
    uniqueIndex("idx_consumer_publications_uniq").on(t.consumer_id, t.publication_id),
    index("idx_consumer_publications_pub").on(t.publication_id, t.tenant_id),
    index("idx_consumer_publications_tenant").on(t.tenant_id),
  ],
);

export const publication_pricing = pgTable(
  "publication_pricing",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    publication_id: text("publication_id").notNull(),
    mode: text("mode").notNull().default("free"),
    price_amount: bigint("price_amount", { mode: "number" }).notNull().default(0),
    currency: text("currency").notNull().default("usd"),
    included_credits: bigint("included_credits", { mode: "number" }).notNull().default(0),
    stripe_price_id: text("stripe_price_id"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("idx_publication_pricing_publication").on(t.publication_id),
    index("idx_publication_pricing_tenant").on(t.tenant_id),
  ],
);
