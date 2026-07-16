// Consumer (end-user) realm + per-publication pricing — Node self-host SQLite
// schema (issue #226).
//
// The public chat surface (/p/:slug) authenticates end-users with a custom
// magic-link + guest flow distinct from tenant owners (no `membership` row is
// ever created for a consumer). On Cloudflare these tables are hand-written SQL
// migrations (apps/main/migrations/0020_consumer_tables.sql +
// 0021_consumer_payments.sql + 0022_consumer_guest_publications.sql); on Node
// they're drizzle-managed here so `pnpm db:generate:node-sqlite` emits them
// into apps/main-node/migrations-sqlite.
//
// Node-only ON PURPOSE — cf-auth (which drizzle.cf-auth.config.ts turns into
// apps/main/migrations) must NOT gain these, or `db:generate:cf-auth` would
// emit a duplicate CF migration for tables 0020-0022 already ship by hand.
//
// Notes:
//   - Timestamps are TEXT ISO-8601 strings (not integer epochs) to match the
//     CF migrations the shared consumer-auth handlers were written against.
//   - `used` is a 0/1 INTEGER flag (bound as 0/1, never a JS boolean, so the
//     same store SQL runs on D1, better-sqlite3, and postgres alike).
//   - No FK constraints: D1 runs with foreign_keys OFF and Node sqlite mirrors
//     that (PRAGMA foreign_keys = OFF), so declaring them here would only add
//     enforcement on postgres that the CF path never had. Uniqueness +
//     lookup indexes carry the invariants that matter.

import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** Public-facing end-users authenticated via magic link or guest mode. */
export const consumers = sqliteTable("consumers", {
  id: text("id").primaryKey().notNull(),
  email: text("email").notNull().unique(),
  name: text("name").notNull().default(""),
  auth_provider: text("auth_provider").notNull().default("email_otp"),
  tenant_id: text("tenant_id"),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
});

/** One-time tokens for email-based sign-in. */
export const magic_links = sqliteTable(
  "magic_links",
  {
    token: text("token").primaryKey().notNull(),
    consumer_id: text("consumer_id").notNull(),
    expires_at: text("expires_at").notNull(),
    used: integer("used").notNull().default(0),
    created_at: text("created_at").notNull(),
  },
  (t) => [index("idx_magic_links_consumer").on(t.consumer_id)],
);

/** Bearer tokens issued after magic-link verification or guest signup. */
export const consumer_sessions = sqliteTable(
  "consumer_sessions",
  {
    token: text("token").primaryKey().notNull(),
    consumer_id: text("consumer_id").notNull(),
    expires_at: text("expires_at").notNull(),
    created_at: text("created_at").notNull(),
  },
  (t) => [index("idx_consumer_sessions_consumer").on(t.consumer_id)],
);

/** consumer <-> publication association (first-seen / last-seen). */
export const consumer_publications = sqliteTable(
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

/** Per-publication pricing. Read by the paywall seam to distinguish a free
 *  publication (allow) from a metered one (honest 501 on self-host). */
export const publication_pricing = sqliteTable(
  "publication_pricing",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    publication_id: text("publication_id").notNull(),
    mode: text("mode").notNull().default("free"),
    price_amount: integer("price_amount").notNull().default(0),
    currency: text("currency").notNull().default("usd"),
    included_credits: integer("included_credits").notNull().default(0),
    stripe_price_id: text("stripe_price_id"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("idx_publication_pricing_publication").on(t.publication_id),
    index("idx_publication_pricing_tenant").on(t.tenant_id),
  ],
);
