// /v1/usage route tests (issue #231).
//
// Covers the four gaps fixed here:
//   1. by_kind entries use `total`, not `total_seconds` (the old name lied
//      about the unit for the model_*_tokens kinds).
//   2. `?days=` range support (1-90, default 30, 0 = all-time) — verifies
//      totals AND the daily series respect the window, invalid values 400,
//      out-of-range values clamp.
//   3. `?group_by=agent` per-agent breakdown, including the unattributed
//      (agent_id IS NULL) bucket and agent name resolution.
//   4. Tenant isolation — unchanged, but re-verified against the new
//      period-scoped queries.
//
// Uses the real MAIN_DB binding; usage_events/agents tables are created up
// front (migrations aren't auto-applied in this pool, mirroring
// deployments.test/consumer-auth.test).

import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, it, expect } from "vitest";
import { Hono } from "hono";
import usageRoutes from "./usage";

const db = () => (env as unknown as { MAIN_DB: D1Database }).MAIN_DB;

const DAY_MS = 24 * 3600 * 1000;
const NOW = Date.now();

async function setupTables() {
  await db()
    .prepare(
      `CREATE TABLE IF NOT EXISTS usage_events (
         id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL,
         session_id TEXT NOT NULL, agent_id TEXT, kind TEXT NOT NULL,
         value INTEGER NOT NULL, instance_type TEXT, created_at INTEGER NOT NULL,
         billed_at INTEGER)`,
    )
    .run();
  await db()
    .prepare(
      `CREATE TABLE IF NOT EXISTS agents (
         id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, config TEXT NOT NULL,
         version INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER,
         archived_at INTEGER)`,
    )
    .run();
}

async function reset() {
  await db().prepare("DELETE FROM usage_events").run();
  await db().prepare("DELETE FROM agents").run();

  await db()
    .prepare(
      `INSERT INTO agents (id, tenant_id, config, version, created_at) VALUES (?, ?, ?, 1, ?)`,
    )
    .bind("agent_1", "tenant-a", JSON.stringify({ name: "Agent One" }), NOW)
    .run();
  await db()
    .prepare(
      `INSERT INTO agents (id, tenant_id, config, version, created_at) VALUES (?, ?, ?, 1, ?)`,
    )
    .bind("agent_2", "tenant-a", JSON.stringify({ name: "Agent Two" }), NOW)
    .run();

  const rows: Array<{
    tenant_id: string;
    session_id: string;
    agent_id: string | null;
    kind: string;
    value: number;
    instance_type: string | null;
    created_at: number;
  }> = [
    // tenant-a, ~1 day ago, agent_1
    { tenant_id: "tenant-a", session_id: "s1", agent_id: "agent_1", kind: "sandbox_active_seconds", value: 100, instance_type: "lite", created_at: NOW - 1 * DAY_MS },
    { tenant_id: "tenant-a", session_id: "s1", agent_id: "agent_1", kind: "model_input_tokens", value: 5000, instance_type: null, created_at: NOW - 1 * DAY_MS },
    { tenant_id: "tenant-a", session_id: "s1", agent_id: "agent_1", kind: "model_output_tokens", value: 2000, instance_type: null, created_at: NOW - 1 * DAY_MS },
    // tenant-a, ~2 days ago, agent_2
    { tenant_id: "tenant-a", session_id: "s2", agent_id: "agent_2", kind: "sandbox_active_seconds", value: 50, instance_type: "standard-1", created_at: NOW - 2 * DAY_MS },
    // tenant-a, ~2 days ago, unattributed (no agent_id)
    { tenant_id: "tenant-a", session_id: "s3", agent_id: null, kind: "session_alive_seconds", value: 500, instance_type: null, created_at: NOW - 2 * DAY_MS },
    // tenant-a, 60 days ago (outside default 30d window, inside 90d) — agent_1
    { tenant_id: "tenant-a", session_id: "s-old", agent_id: "agent_1", kind: "sandbox_active_seconds", value: 99999, instance_type: "lite", created_at: NOW - 60 * DAY_MS },
    // tenant-a, 200 days ago (outside even the 90d clamp; only all-time sees it)
    { tenant_id: "tenant-a", session_id: "s-ancient", agent_id: "agent_1", kind: "sandbox_active_seconds", value: 42, instance_type: "lite", created_at: NOW - 200 * DAY_MS },
    // tenant-b — must never leak into tenant-a's response
    { tenant_id: "tenant-b", session_id: "s-b1", agent_id: null, kind: "sandbox_active_seconds", value: 777, instance_type: null, created_at: NOW - 1 * DAY_MS },
  ];

  for (const r of rows) {
    await db()
      .prepare(
        `INSERT INTO usage_events (tenant_id, session_id, agent_id, kind, value, instance_type, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(r.tenant_id, r.session_id, r.agent_id, r.kind, r.value, r.instance_type, r.created_at)
      .run();
  }
}

// Tenant-scoped app: a tiny middleware stands in for tenantDbMiddleware +
// authMiddleware, seeding c.var.tenant_id / tenantDb directly — the single
// D1 shard in this test env is MAIN_DB regardless of tenant.
function tenantApp(tenantId = "tenant-a") {
  const app = new Hono();
  app.use("/v1/usage/*", async (c, next) => {
    c.set("tenant_id" as never, tenantId as never);
    c.set("tenantDb" as never, db() as never);
    await next();
  });
  app.route("/v1/usage", usageRoutes);
  return app;
}

const call = (app: Hono, path: string) => app.request(path, undefined, env as unknown as Record<string, unknown>);

interface UsageByKindRow {
  kind: string;
  total: number;
}
interface UsageByAgentRow {
  agent_id: string | null;
  agent_name: string | null;
  total_active_seconds: number;
  total_sessions: number;
  by_kind: UsageByKindRow[];
}
interface UsageBody {
  period: { days: number; since: string | null };
  total_active_seconds: number;
  total_sessions: number;
  by_kind: UsageByKindRow[];
  by_instance_type: Array<{ instance_type: string | null; total_seconds: number }>;
  daily: Array<{ date: string; active_seconds: number; runs: number }>;
  by_agent?: UsageByAgentRow[];
}

beforeAll(setupTables);
beforeEach(reset);

describe("GET /v1/usage — default (days=30)", () => {
  it("uses `total` (not total_seconds) on by_kind, and excludes rows older than 30 days", async () => {
    const app = tenantApp();
    const res = await call(app, "/v1/usage");
    expect(res.status).toBe(200);
    const body = (await res.json()) as UsageBody;

    expect(body.period).toEqual({ days: 30, since: expect.any(String) });

    // 100 (s1) + 50 (s2) — the 60d and 200d rows are excluded.
    expect(body.total_active_seconds).toBe(150);
    expect(body.total_sessions).toBe(3); // s1, s2, s3

    const sandboxKind = body.by_kind.find((k) => k.kind === "sandbox_active_seconds");
    expect(sandboxKind).toEqual({ kind: "sandbox_active_seconds", total: 150 });
    expect(sandboxKind).not.toHaveProperty("total_seconds");
    expect(body.by_kind.find((k) => k.kind === "model_input_tokens")).toEqual({
      kind: "model_input_tokens",
      total: 5000,
    });
    expect(body.by_kind.find((k) => k.kind === "model_output_tokens")).toEqual({
      kind: "model_output_tokens",
      total: 2000,
    });

    // by_instance_type keeps its existing (genuinely-seconds) field name.
    expect(body.by_instance_type).toEqual(
      expect.arrayContaining([
        { instance_type: "lite", total_seconds: 100 },
        { instance_type: "standard-1", total_seconds: 50 },
      ]),
    );

    expect(body.by_agent).toBeUndefined();
  });

  it("never leaks tenant-a's usage into tenant-b's response", async () => {
    const app = tenantApp("tenant-b");
    const res = await call(app, "/v1/usage");
    const body = (await res.json()) as UsageBody;
    expect(body.total_active_seconds).toBe(777);
    expect(body.total_sessions).toBe(1);
    expect(body.by_kind).toEqual([{ kind: "sandbox_active_seconds", total: 777 }]);
  });
});

describe("GET /v1/usage?days=", () => {
  it("days=0 returns all-time totals (since: null)", async () => {
    const app = tenantApp();
    const res = await call(app, "/v1/usage?days=0");
    const body = (await res.json()) as UsageBody;
    expect(body.period).toEqual({ days: 0, since: null });
    // 100 + 50 + 99999 + 42 — every row, including the 60d and 200d ones.
    expect(body.total_active_seconds).toBe(100191);
    expect(body.total_sessions).toBe(5); // s1, s2, s3, s-old, s-ancient
  });

  it("days=90 includes the 60-day-old row but not the 200-day-old one", async () => {
    const app = tenantApp();
    const res = await call(app, "/v1/usage?days=90");
    const body = (await res.json()) as UsageBody;
    expect(body.period.days).toBe(90);
    expect(body.total_active_seconds).toBe(100149); // 100 + 50 + 99999
  });

  it("clamps an out-of-range days value to 90", async () => {
    const app = tenantApp();
    const res = await call(app, "/v1/usage?days=200");
    const body = (await res.json()) as UsageBody;
    expect(body.period.days).toBe(90);
    expect(body.total_active_seconds).toBe(100149);
  });

  it("rejects a non-numeric days value with 400", async () => {
    const app = tenantApp();
    const res = await call(app, "/v1/usage?days=abc");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_days");
  });

  it("rejects a negative days value with 400", async () => {
    const app = tenantApp();
    const res = await call(app, "/v1/usage?days=-5");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_days");
  });

  it("the daily series also respects the window", async () => {
    const app = tenantApp();
    const res7 = await call(app, "/v1/usage?days=7");
    const body7 = (await res7.json()) as UsageBody;
    // Only the ~1d and ~2d-old sandbox rows fall inside a 7-day window.
    expect(body7.daily.reduce((sum, d) => sum + d.active_seconds, 0)).toBe(150);

    const res90 = await call(app, "/v1/usage?days=90");
    const body90 = (await res90.json()) as UsageBody;
    expect(body90.daily.reduce((sum, d) => sum + d.active_seconds, 0)).toBe(100149);
  });
});

describe("GET /v1/usage?group_by=agent", () => {
  it("groups totals per agent, including the unattributed (null) bucket, within the default 30d window", async () => {
    const app = tenantApp();
    const res = await call(app, "/v1/usage?group_by=agent");
    const body = (await res.json()) as UsageBody;
    expect(body.by_agent).toBeDefined();
    const byAgent = body.by_agent!;

    const agent1 = byAgent.find((a) => a.agent_id === "agent_1")!;
    expect(agent1.agent_name).toBe("Agent One");
    expect(agent1.total_active_seconds).toBe(100); // the 60d/200d rows are outside the default window
    expect(agent1.total_sessions).toBe(1);
    expect(agent1.by_kind).toEqual(
      expect.arrayContaining([
        { kind: "sandbox_active_seconds", total: 100 },
        { kind: "model_input_tokens", total: 5000 },
        { kind: "model_output_tokens", total: 2000 },
      ]),
    );

    const agent2 = byAgent.find((a) => a.agent_id === "agent_2")!;
    expect(agent2.agent_name).toBe("Agent Two");
    expect(agent2.total_active_seconds).toBe(50);
    expect(agent2.total_sessions).toBe(1);
    expect(agent2.by_kind).toEqual([{ kind: "sandbox_active_seconds", total: 50 }]);

    const unattributed = byAgent.find((a) => a.agent_id === null)!;
    expect(unattributed.agent_name).toBeNull();
    expect(unattributed.total_active_seconds).toBe(0); // session_alive_seconds isn't the sandbox kind
    expect(unattributed.total_sessions).toBe(1);
    expect(unattributed.by_kind).toEqual([{ kind: "session_alive_seconds", total: 500 }]);
  });

  it("combines with days= — all-time grouping picks up the older rows too", async () => {
    const app = tenantApp();
    const res = await call(app, "/v1/usage?group_by=agent&days=0");
    const body = (await res.json()) as UsageBody;
    const agent1 = body.by_agent!.find((a) => a.agent_id === "agent_1")!;
    expect(agent1.total_active_seconds).toBe(100 + 99999 + 42);
  });

  it("rejects an unsupported group_by value with 400", async () => {
    const app = tenantApp();
    const res = await call(app, "/v1/usage?group_by=bogus");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_group_by");
  });

  it("never leaks tenant-a's agents into tenant-b's by_agent breakdown", async () => {
    const app = tenantApp("tenant-b");
    const res = await call(app, "/v1/usage?group_by=agent&days=0");
    const body = (await res.json()) as UsageBody;
    expect(body.by_agent).toEqual([
      {
        agent_id: null,
        agent_name: null,
        total_active_seconds: 777,
        total_sessions: 1,
        by_kind: [{ kind: "sandbox_active_seconds", total: 777 }],
      },
    ]);
  });
});
