// Node-pool integration test for the shared /v1/stats and /v1/usage routes
// (packages/http-routes/src/stats, .../usage) against a REAL better-sqlite3
// SqlClient — not a mock. Exercises the portability rewrite from issue #171:
// the original CF-local usage.ts used SQLite-only `DATE(created_at/1000,
// 'unixepoch')` and `json_extract(a.config,'$.name')`, both rewritten to
// portable SQL + JS-side bucketing/lookup so the same route runs unchanged
// on D1 (CF) and Postgres/SQLite (self-host Node). This test constructs the
// route directly (no full main-node process spawn) — fast, and it drives
// the exact SqlClient adapter self-host Node wires in production.

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { createBetterSqlite3SqlClient } from "@duyet/oma-sql-client";
import { InMemoryKvStore } from "@duyet/oma-kv-store/adapters/in-memory";
import { buildStatsRoutes, buildUsageRoutes, type RouteServices } from "@duyet/oma-http-routes";

const TENANT = "tn_usage_test";
const OTHER_TENANT = "tn_other";

async function seedDb() {
  const sql = await createBetterSqlite3SqlClient(":memory:");
  // Mirrors apps/main-node/migrations-sqlite/0000_consolidated.sql +
  // 0010_usage_events_instance_type.sql (the migration this task adds).
  await sql.exec(`
    CREATE TABLE usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      agent_id TEXT,
      kind TEXT NOT NULL,
      value INTEGER NOT NULL,
      instance_type TEXT,
      created_at INTEGER NOT NULL,
      billed_at INTEGER
    );
  `);
  return sql;
}

function makeServices(sql: Awaited<ReturnType<typeof seedDb>>): RouteServices {
  const kv = new InMemoryKvStore();
  const agentNames: Record<string, string> = { agent_a: "Agent A", agent_b: "Agent B" };
  return {
    sql,
    kv,
    agents: {
      count: async () => 2,
      get: async ({ agentId }: { agentId: string }) =>
        agentNames[agentId] ? { name: agentNames[agentId] } : null,
    },
    sessions: { count: async () => 5 },
    environments: { count: async () => 1 },
    vaults: { count: async () => 0 },
    modelCards: { list: async () => [] },
  } as unknown as RouteServices;
}

function makeApp(services: RouteServices) {
  const app = new Hono<{ Variables: { tenant_id: string } }>();
  app.use("*", async (c, next) => {
    c.set("tenant_id", TENANT);
    await next();
  });
  app.route("/v1/stats", buildStatsRoutes({ services }));
  app.route("/v1/usage", buildUsageRoutes({ services }));
  return app;
}

const DAY = 24 * 3600 * 1000;

describe("/v1/stats and /v1/usage — real SqlClient (better-sqlite3)", () => {
  let sql: Awaited<ReturnType<typeof seedDb>>;
  let app: Hono;

  beforeAll(async () => {
    sql = await seedDb();
    const now = Date.now();

    const insert = async (row: {
      tenantId: string;
      sessionId: string;
      agentId: string | null;
      kind: string;
      value: number;
      instanceType: string | null;
      createdAt: number;
    }) => {
      await sql
        .prepare(
          `INSERT INTO usage_events (tenant_id, session_id, agent_id, kind, value, instance_type, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          row.tenantId,
          row.sessionId,
          row.agentId,
          row.kind,
          row.value,
          row.instanceType,
          row.createdAt,
        )
        .run();
    };

    // Two sessions, two days, two agents — enough to exercise by_kind,
    // by_instance_type, daily bucketing, session count, and by_agent.
    await insert({
      tenantId: TENANT,
      sessionId: "sess_1",
      agentId: "agent_a",
      kind: "sandbox_active_seconds",
      value: 100,
      instanceType: "standard",
      createdAt: now - 1 * DAY,
    });
    await insert({
      tenantId: TENANT,
      sessionId: "sess_1",
      agentId: "agent_a",
      kind: "model_input_tokens",
      value: 500,
      instanceType: null,
      createdAt: now - 1 * DAY,
    });
    await insert({
      tenantId: TENANT,
      sessionId: "sess_2",
      agentId: "agent_b",
      kind: "sandbox_active_seconds",
      value: 50,
      instanceType: "large",
      createdAt: now - 1 * DAY,
    });
    await insert({
      tenantId: TENANT,
      sessionId: "sess_2",
      agentId: null,
      kind: "sandbox_active_seconds",
      value: 25,
      instanceType: null,
      createdAt: now - 40 * DAY, // outside default 30-day window
    });
    // Different tenant — must never leak into TENANT's aggregates.
    await insert({
      tenantId: OTHER_TENANT,
      sessionId: "sess_x",
      agentId: null,
      kind: "sandbox_active_seconds",
      value: 9999,
      instanceType: null,
      createdAt: now - 1 * DAY,
    });

    app = makeApp(makeServices(sql));
  });

  describe("GET /v1/stats", () => {
    it("aggregates the two portable usage_events queries scoped to the tenant", async () => {
      const res = await app.request("/v1/stats");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.agents).toBe(2);
      expect(body.sessions).toBe(5);
      // all-time sandbox seconds for TENANT: 100 + 50 + 25 = 175 (the
      // 40-day-old row IS counted here — stats has no time window).
      expect(body.total_sandbox_seconds).toBe(175);
      // distinct sessions with ANY usage_events row for TENANT: sess_1, sess_2.
      expect(body.total_usage_sessions).toBe(2);
    });
  });

  describe("GET /v1/usage", () => {
    it("defaults to a 30-day window and returns portable aggregates", async () => {
      const res = await app.request("/v1/usage");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.period.days).toBe(30);
      // 40-day-old row is excluded by the default window.
      expect(body.total_active_seconds).toBe(150);
      expect(body.total_sessions).toBe(2);
      const kinds = Object.fromEntries(body.by_kind.map((k: { kind: string; total: number }) => [k.kind, k.total]));
      expect(kinds.sandbox_active_seconds).toBe(150);
      expect(kinds.model_input_tokens).toBe(500);
      const instances = Object.fromEntries(
        body.by_instance_type.map((i: { instance_type: string; total_seconds: number }) => [
          i.instance_type,
          i.total_seconds,
        ]),
      );
      expect(instances.standard).toBe(100);
      expect(instances.large).toBe(50);
    });

    it("bucketes daily seconds by UTC day in JS (portability rewrite)", async () => {
      const res = await app.request("/v1/usage?days=90");
      const body = await res.json();
      const yesterday = new Date(Date.now() - 1 * DAY).toISOString().slice(0, 10);
      const bucket = body.daily.find((d: { date: string }) => d.date === yesterday);
      expect(bucket).toBeTruthy();
      expect(bucket.active_seconds).toBe(150);
      expect(bucket.runs).toBe(2); // sess_1 + sess_2 both active that day
      // Sorted ascending.
      const dates = body.daily.map((d: { date: string }) => d.date);
      expect([...dates].sort()).toEqual(dates);
    });

    it("days=0 is all-time — includes the 40-day-old row", async () => {
      const res = await app.request("/v1/usage?days=0");
      const body = await res.json();
      expect(body.period.days).toBe(0);
      expect(body.period.since).toBeNull();
      expect(body.total_active_seconds).toBe(175);
    });

    it("rejects a non-integer days (400)", async () => {
      const res = await app.request("/v1/usage?days=abc");
      expect(res.status).toBe(400);
    });

    it("rejects an unsupported group_by (400)", async () => {
      const res = await app.request("/v1/usage?group_by=session");
      expect(res.status).toBe(400);
    });

    it("group_by=agent resolves agent_name via services.agents.get (json_extract rewrite)", async () => {
      const res = await app.request("/v1/usage?days=90&group_by=agent");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.by_agent).toBeTruthy();
      const byId = Object.fromEntries(
        body.by_agent.map((a: { agent_id: string | null; agent_name: string | null }) => [
          a.agent_id,
          a.agent_name,
        ]),
      );
      expect(byId["agent_a"]).toBe("Agent A");
      expect(byId["agent_b"]).toBe("Agent B");
      // agent_id IS NULL rows (not attributed to any agent) surface as
      // their own bucket rather than being dropped, with a null agent_name.
      const nullBucket = body.by_agent.find(
        (a: { agent_id: string | null }) => a.agent_id === null,
      );
      expect(nullBucket).toBeTruthy();
      expect(nullBucket.agent_name).toBeNull();
    });

    it("scopes every aggregate to the requesting tenant — no cross-tenant leakage", async () => {
      const res = await app.request("/v1/usage?days=90");
      const body = await res.json();
      // 9999 from OTHER_TENANT must never appear in TENANT's totals.
      expect(body.total_active_seconds).toBeLessThan(9999);
    });
  });
});
