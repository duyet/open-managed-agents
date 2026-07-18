// Tenant teammate invites — Node self-host PG schema (issue #175).
//
// Node-only ON PURPOSE, mirroring ./consumers: on Cloudflare the same table
// ships as a hand-written SQL migration (apps/main/migrations/
// 0031_tenant_invites.sql). Here it's drizzle-managed so
// `pnpm db:generate:node-pg` emits it into apps/main-node/migrations.
//
// Timestamps are BIGINT ms-since-epoch (matches the pagination cursor codec
// and the CF migration). No FK constraints — parity with the CF path.

import { bigint, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

export const tenant_invites = pgTable(
  "tenant_invites",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    email: text("email").notNull(),
    role: text("role").notNull().default("member"),
    status: text("status").notNull().default("pending"),
    token: text("token").notNull(),
    invited_by: text("invited_by"),
    created_at: bigint("created_at", { mode: "number" }).notNull(),
    expires_at: bigint("expires_at", { mode: "number" }).notNull(),
    accepted_at: bigint("accepted_at", { mode: "number" }),
    accepted_by: text("accepted_by"),
  },
  (t) => [
    uniqueIndex("idx_tenant_invites_token").on(t.token),
    index("idx_tenant_invites_tenant").on(t.tenant_id, t.created_at, t.id),
    index("idx_tenant_invites_tenant_email").on(t.tenant_id, t.email, t.status),
  ],
);
