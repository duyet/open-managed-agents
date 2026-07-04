// Control-plane routing tables, folded into MAIN_DB (CF SQLite / D1).
//
// Identical schema to packages/db-schema/src/cf-router/sharding.ts (the
// ROUTER_DB source of truth for true multi-shard deployments) — kept as a
// separate copy here because single-D1 deployments (self-host default AND
// oma.duyet.net's launch layout) never bind a standalone ROUTER_DB: code
// resolves the control plane via `env.ROUTER_DB ?? env.MAIN_DB`, so these
// tables must physically exist on MAIN_DB. In particular, `ensureTenant()`
// (apps/main/src/auth-config.ts) does an unconditional INSERT into
// tenant_shard on every signup, even in single-D1 mode — without this
// table on MAIN_DB, every signup throws.
//
// If the cf-router shape ever changes, mirror the change here too (and vice
// versa) — the two schemas must stay identical.

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// One row per tenant. Sticky: a tenant lives on its assigned shard
// forever (or until manually rebalanced via the rebalance script).
// Hot-path read on every authenticated request via
// MetaTableTenantDbProvider in packages/tenant-db/src/cf-meta-router.ts;
// callers KV-cache the result for 1hr so steady-state load is low.
export const tenant_shard = sqliteTable(
  "tenant_shard",
  {
    tenant_id: text("tenant_id").primaryKey().notNull(),
    binding_name: text("binding_name").notNull(), // e.g. 'AUTH_DB_00'
    created_at: integer("created_at").notNull(), // ms epoch
  },
  (t) => [index("idx_tenant_shard_binding").on(t.binding_name)],
);

// Pool of available shards. `tenant_count` + `size_bytes` are observed
// by a periodic cron and used by pickShardForNewTenant() in
// packages/tenant-dbs-store to pick the least-loaded open shard for a
// new tenant. status: 'open' = accepts new; 'draining' = no new
// tenants, existing stay; 'full' = read-only / hand off; 'archived'
// = deprovisioned.
export const shard_pool = sqliteTable(
  "shard_pool",
  {
    binding_name: text("binding_name").primaryKey().notNull(),
    status: text("status").notNull().default("open"),
    tenant_count: integer("tenant_count").notNull().default(0),
    size_bytes: integer("size_bytes"),
    observed_at: integer("observed_at"),
    notes: text("notes"),
  },
  (t) => [index("idx_shard_pool_status").on(t.status, t.tenant_count)],
);

// memory_store_id → tenant_id reverse index. Populated synchronously
// when a memory store is created (apps/main/src/routes/memory.ts POST
// /v1/memory). The R2 → MEMORY_EVENTS_QUEUE consumer queries this
// once per event to find the owning tenant when only the bucket key
// is known.
export const memory_store_tenant = sqliteTable(
  "memory_store_tenant",
  {
    store_id: text("store_id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    created_at: integer("created_at").notNull(), // ms epoch
  },
  (t) => [index("idx_memory_store_tenant_tenant").on(t.tenant_id)],
);
