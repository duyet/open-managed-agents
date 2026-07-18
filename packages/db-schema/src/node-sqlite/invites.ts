// Tenant teammate invites — Node self-host SQLite schema (issue #175).
//
// Node-only ON PURPOSE, mirroring ./consumers: on Cloudflare the same table
// ships as a hand-written SQL migration (apps/main/migrations/
// 0031_tenant_invites.sql), so cf-auth must NOT gain it or `db:generate:cf-auth`
// would emit a duplicate CF migration. Here it's drizzle-managed so
// `pnpm db:generate:node-sqlite` emits it into apps/main-node/migrations-sqlite.
//
// Timestamps are INTEGER ms-since-epoch (matches the pagination cursor codec
// and the CF migration). No FK constraints (D1 + Node sqlite run with
// foreign_keys OFF); the unique token index + lookup indexes carry the
// invariants that matter.

import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const tenant_invites = sqliteTable(
  "tenant_invites",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    email: text("email").notNull(),
    // 'admin' | 'member' ('owner' is reserved for the workspace creator).
    role: text("role").notNull().default("member"),
    // 'pending' | 'accepted' | 'revoked'.
    status: text("status").notNull().default("pending"),
    token: text("token").notNull(),
    invited_by: text("invited_by"),
    created_at: integer("created_at").notNull(),
    expires_at: integer("expires_at").notNull(),
    accepted_at: integer("accepted_at"),
    accepted_by: text("accepted_by"),
  },
  (t) => [
    uniqueIndex("idx_tenant_invites_token").on(t.token),
    index("idx_tenant_invites_tenant").on(t.tenant_id, t.created_at, t.id),
    index("idx_tenant_invites_tenant_email").on(t.tenant_id, t.email, t.status),
  ],
);
