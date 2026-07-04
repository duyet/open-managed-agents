// Node self-host SQLite schema — union of cf-auth + cf-integrations +
// cf-router, all SQLite-typed (no PG-typed columns).
//
// Self-host SQLite runs on better-sqlite3 against the same SQLite engine
// D1 uses, so the cf-* table definitions apply unchanged. The only thing
// this barrel adds is "everything in one folder" for drizzle-kit to emit
// a single consolidated baseline (apps/main-node/migrations-sqlite/)
// rather than three.
//
// drizzle-kit consumes this barrel via drizzle.node-sqlite.config.ts.
//
// NOTE: ../cf-router is NOT re-exported here. Its entire schema (tenant_shard,
// shard_pool, memory_store_tenant) is now also defined in ../cf-auth (folded
// in so single-D1 CF deployments have the tables on MAIN_DB — see
// packages/db-schema/src/cf-auth/sharding.ts) — re-exporting both would
// collide on those 3 table names. cf-auth's copy already covers everything
// cf-router would have contributed here.

export * from "../cf-auth";
export * from "../cf-integrations";
