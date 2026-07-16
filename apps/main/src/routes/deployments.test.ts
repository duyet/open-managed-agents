// Deployments CRUD + trigger wiring tests.
//
// Covers what's testable against real D1 in the workers pool (session
// creation / run success needs a full sandbox, so the run path is covered at
// the scheduler-tick layer in packages/scheduler; here we cover CRUD,
// validation, trigger-specific side effects, webhook-token resolution, and
// the x-api-key auth bypass on the webhook endpoint):
//   - create: manual / webhook (mints hook_token + webhook_url) / schedule
//     (seeds next_run_at); 422 on invalid input
//   - list: cursor pagination, tenant scoping
//   - get / patch / delete, 404s, tenant isolation
//   - webhook endpoint: unknown token → 404 (not 401 — proves auth bypass),
//     disabled deployment → 403
//
// Uses the real MAIN_DB binding; the deployments table is created up front
// (migrations aren't auto-applied in this pool, mirroring consumer-auth.test).

import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, it, expect } from "vitest";
import { Hono } from "hono";
import deploymentsRoutes, { deploymentHooksRoutes } from "./deployments";
import { authMiddleware } from "../auth";

const db = () => (env as unknown as { MAIN_DB: D1Database }).MAIN_DB;

// The two tenants the tests act as; each is seeded with agent_1 (current
// version 3) + env_1 so create/update reference-validation passes.
const TENANTS = ["tenant-a", "tenant-b"];

async function setupTables() {
  await db()
    .prepare(
      `CREATE TABLE IF NOT EXISTS deployments (
         id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL,
         agent_id TEXT NOT NULL, agent_version INTEGER, environment_id TEXT NOT NULL,
         vault_ids TEXT NOT NULL DEFAULT '[]', memory_store_ids TEXT NOT NULL DEFAULT '[]',
         initial_message TEXT NOT NULL, trigger TEXT NOT NULL DEFAULT '{"type":"manual"}',
         hook_token TEXT, user_id TEXT, enabled INTEGER NOT NULL DEFAULT 1,
         next_run_at TEXT, last_run_at TEXT, last_run_status TEXT, last_run_error TEXT,
         last_session_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    )
    .run();
  await db()
    .prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_deployments_hook_token ON deployments(hook_token)`)
    .run();

  // agents / agent_versions / environments live in the tenant shard, which in
  // the single-shard test env resolves to MAIN_DB. Reference-validation on
  // create/update reads them via services, so the tables + rows must exist.
  await db()
    .prepare(
      `CREATE TABLE IF NOT EXISTS agents (
         id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, config TEXT NOT NULL,
         version INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER, archived_at INTEGER)`,
    )
    .run();
  await db()
    .prepare(
      `CREATE TABLE IF NOT EXISTS agent_versions (
         agent_id TEXT NOT NULL, tenant_id TEXT NOT NULL, version INTEGER NOT NULL,
         snapshot TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(agent_id, version))`,
    )
    .run();
  await db()
    .prepare(
      `CREATE TABLE IF NOT EXISTS environments (
         id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, name TEXT NOT NULL,
         description TEXT, status TEXT NOT NULL, sandbox_worker_name TEXT, build_error TEXT,
         config TEXT NOT NULL, metadata TEXT, created_at INTEGER NOT NULL, updated_at INTEGER,
         archived_at INTEGER, image_strategy TEXT, image_handle TEXT)`,
    )
    .run();

  const nowMs = Date.now();
  for (const tenant of TENANTS) {
    // agent_1 at current version 3 (so a pin of 3 is the live version and a
    // pin of 1/2 must resolve via agent_versions history).
    await db()
      .prepare(
        `INSERT OR IGNORE INTO agents (id, tenant_id, config, version, created_at)
         VALUES (?, ?, ?, 3, ?)`,
      )
      .bind("agent_1", tenant, JSON.stringify({ id: "agent_1", name: "A", model: "claude-sonnet-4-6", system: "", tools: [], version: 3 }), nowMs)
      .run();
    for (const v of [1, 2]) {
      await db()
        .prepare(
          `INSERT OR IGNORE INTO agent_versions (agent_id, tenant_id, version, snapshot, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind("agent_1", tenant, v, JSON.stringify({ id: "agent_1", name: "A", model: "claude-sonnet-4-6", system: "", tools: [], version: v }), nowMs)
        .run();
    }
    await db()
      .prepare(
        `INSERT OR IGNORE INTO environments (id, tenant_id, name, status, config, created_at)
         VALUES (?, ?, ?, 'ready', ?, ?)`,
      )
      .bind("env_1", tenant, "E", JSON.stringify({ type: "cloud" }), nowMs)
      .run();
  }
}

async function reset() {
  await db().prepare("DELETE FROM deployments").run();
}

// Tenant-scoped app: a tiny middleware stands in for authMiddleware, seeding
// c.var.tenant_id / user_id the way the real one does after resolving a key.
function tenantApp(tenantId = "tenant-a", userId = "user-1") {
  const app = new Hono();
  app.use("/v1/deployments/*", async (c, next) => {
    c.set("tenant_id" as never, tenantId as never);
    c.set("user_id" as never, userId as never);
    await next();
  });
  app.route("/v1/deployments", deploymentsRoutes);
  return app;
}

const call = (app: Hono, path: string, init?: RequestInit) =>
  app.request(path, init, env as unknown as Record<string, unknown>);

const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeAll(setupTables);
beforeEach(reset);

const base = {
  name: "Nightly digest",
  agent_id: "agent_1",
  environment_id: "env_1",
  initial_message: "Post the digest.",
};

describe("create", () => {
  it("creates a manual deployment (no hook_token, no next_run_at)", async () => {
    const app = tenantApp();
    const res = await call(app, "/v1/deployments", json({ ...base, trigger: { type: "manual" } }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toMatch(/^dep_/);
    expect(body.trigger).toEqual({ type: "manual" });
    expect(body.webhook_url).toBeUndefined();
    expect(body.next_run_at).toBeNull();
    expect(body.enabled).toBe(true);
  });

  it("mints a hook_token + webhook_url for a webhook trigger", async () => {
    const app = tenantApp();
    const res = await call(app, "/v1/deployments", json({ ...base, trigger: { type: "webhook" } }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, string>;
    expect(body.webhook_url).toMatch(/\/v1\/deployment_hooks\/dhk_/);
    const row = await db()
      .prepare("SELECT hook_token FROM deployments WHERE id = ?")
      .bind(body.id)
      .first<{ hook_token: string }>();
    expect(row!.hook_token).toMatch(/^dhk_/);
  });

  it("seeds next_run_at for a schedule trigger", async () => {
    const app = tenantApp();
    const res = await call(
      app,
      "/v1/deployments",
      json({ ...base, trigger: { type: "schedule", cron_expression: "0 9 * * *", timezone: "UTC" } }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.next_run_at).toBe("string");
    expect((body.trigger as { type: string }).type).toBe("schedule");
  });

  it("pins agent_version and persists vault + memory store ids", async () => {
    const app = tenantApp();
    const res = await call(
      app,
      "/v1/deployments",
      json({ ...base, agent_version: 3, vault_ids: ["vlt_a"], memory_store_ids: ["ms_a", "ms_b"] }),
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.agent_version).toBe(3);
    expect(body.vault_ids).toEqual(["vlt_a"]);
    expect(body.memory_store_ids).toEqual(["ms_a", "ms_b"]);
  });

  it("rejects invalid input with 422", async () => {
    const app = tenantApp();
    const missingName = await call(app, "/v1/deployments", json({ agent_id: "a", environment_id: "e", initial_message: "m" }));
    expect(missingName.status).toBe(422);
    const badCron = await call(
      app,
      "/v1/deployments",
      json({ ...base, trigger: { type: "schedule", cron_expression: "not a cron" } }),
    );
    expect(badCron.status).toBe(422);
  });

  it("404s a nonexistent agent_id", async () => {
    const app = tenantApp();
    const res = await call(app, "/v1/deployments", json({ ...base, agent_id: "agent_missing" }));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toMatch(/agent not found/);
  });

  it("404s a nonexistent environment_id", async () => {
    const app = tenantApp();
    const res = await call(app, "/v1/deployments", json({ ...base, environment_id: "env_missing" }));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toMatch(/environment not found/);
  });

  it("422s a pinned agent_version that doesn't exist", async () => {
    const app = tenantApp();
    const res = await call(app, "/v1/deployments", json({ ...base, agent_version: 99 }));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toMatch(/agent version 99 not found/);
  });

  it("accepts a pinned agent_version that exists in history", async () => {
    const app = tenantApp();
    const res = await call(app, "/v1/deployments", json({ ...base, agent_version: 1 }));
    expect(res.status).toBe(201);
    expect(((await res.json()) as { agent_version: number }).agent_version).toBe(1);
  });
});

describe("update reference validation", () => {
  async function create(app: Hono, over: Record<string, unknown> = {}) {
    const res = await call(app, "/v1/deployments", json({ ...base, ...over }));
    return (await res.json()) as Record<string, string>;
  }

  it("404s when patching environment_id to a nonexistent env", async () => {
    const app = tenantApp();
    const dep = await create(app);
    const res = await call(app, `/v1/deployments/${dep.id}`, json({ environment_id: "env_missing" }, "PATCH"));
    expect(res.status).toBe(404);
  });

  it("422s when patching agent_version to a nonexistent version", async () => {
    const app = tenantApp();
    const dep = await create(app);
    const res = await call(app, `/v1/deployments/${dep.id}`, json({ agent_version: 99 }, "PATCH"));
    expect(res.status).toBe(422);
  });
});

describe("list — cursor pagination + tenant scoping", () => {
  it("paginates (created_at, id) DESC and does not leak other tenants", async () => {
    const app = tenantApp("tenant-a");
    for (let i = 0; i < 3; i++) {
      await call(app, "/v1/deployments", json({ ...base, name: `d${i}` }));
    }
    // A second tenant's row must not appear in tenant-a's list.
    await call(tenantApp("tenant-b"), "/v1/deployments", json({ ...base, name: "other" }));

    const page1 = (await (await call(app, "/v1/deployments?limit=2")).json()) as {
      data: unknown[];
      next_cursor?: string;
    };
    expect(page1.data).toHaveLength(2);
    expect(page1.next_cursor).toBeTruthy();

    const page2 = (await (
      await call(app, `/v1/deployments?limit=2&cursor=${page1.next_cursor}`)
    ).json()) as { data: unknown[]; next_cursor?: string };
    expect(page2.data).toHaveLength(1);
    expect(page2.next_cursor).toBeUndefined();
  });

  it("filters by agent_id when the query param is present", async () => {
    const app = tenantApp("tenant-a");
    await call(app, "/v1/deployments", json({ ...base, name: "for-a", agent_id: "agent_a" }));
    await call(app, "/v1/deployments", json({ ...base, name: "for-b", agent_id: "agent_b" }));

    const scoped = (await (
      await call(app, "/v1/deployments?agent_id=agent_a")
    ).json()) as { data: Array<{ name: string; agent_id: string }> };
    expect(scoped.data).toHaveLength(1);
    expect(scoped.data[0]).toMatchObject({ name: "for-a", agent_id: "agent_a" });

    // No filter → both rows.
    const all = (await (await call(app, "/v1/deployments")).json()) as { data: unknown[] };
    expect(all.data).toHaveLength(2);
  });
});

describe("get / patch / delete", () => {
  async function create(app: Hono, over: Record<string, unknown> = {}) {
    const res = await call(app, "/v1/deployments", json({ ...base, ...over }));
    return (await res.json()) as Record<string, string>;
  }

  it("gets by id and 404s cross-tenant", async () => {
    const app = tenantApp("tenant-a");
    const dep = await create(app);
    expect((await call(app, `/v1/deployments/${dep.id}`)).status).toBe(200);
    expect((await call(tenantApp("tenant-b"), `/v1/deployments/${dep.id}`)).status).toBe(404);
  });

  it("patches fields and re-mints hook_token when switching to webhook", async () => {
    const app = tenantApp();
    const dep = await create(app, { trigger: { type: "manual" } });
    const res = await call(
      app,
      `/v1/deployments/${dep.id}`,
      json({ name: "renamed", trigger: { type: "webhook" } }, "PATCH"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.name).toBe("renamed");
    expect(body.webhook_url).toMatch(/dhk_/);
  });

  it("deletes and then 404s", async () => {
    const app = tenantApp();
    const dep = await create(app);
    expect((await call(app, `/v1/deployments/${dep.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await call(app, `/v1/deployments/${dep.id}`)).status).toBe(404);
  });

  it("run 404s for an unknown deployment", async () => {
    const app = tenantApp();
    const res = await call(app, "/v1/deployments/dep_missing/run", json({}));
    expect(res.status).toBe(404);
  });
});

// ─── Webhook endpoint: auth bypass + guards (no session creation needed) ─────

describe("deployment_hooks webhook endpoint", () => {
  // Mount behind the REAL authMiddleware to prove the hook path bypasses it.
  function hookApp() {
    const app = new Hono();
    app.use("/v1/*", authMiddleware);
    app.route("/v1/deployment_hooks", deploymentHooksRoutes);
    return app;
  }

  it("bypasses x-api-key auth: an unknown token returns 404, not 401", async () => {
    const res = await call(hookApp(), "/v1/deployment_hooks/dhk_nope", json({}));
    expect(res.status).toBe(404);
  });

  it("returns 403 for a disabled deployment", async () => {
    const now = new Date().toISOString();
    await db()
      .prepare(
        `INSERT INTO deployments (id, tenant_id, name, agent_id, environment_id, initial_message,
           trigger, hook_token, user_id, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .bind(
        "dep_disabled",
        "tenant-a",
        "d",
        "agent_1",
        "env_1",
        "m",
        '{"type":"webhook"}',
        "dhk_disabledtoken",
        "user-1",
        now,
        now,
      )
      .run();
    const res = await call(hookApp(), "/v1/deployment_hooks/dhk_disabledtoken", json({}));
    expect(res.status).toBe(403);
  });

  it("429s when the per-deployment rate limit is exhausted", async () => {
    const now = new Date().toISOString();
    await db()
      .prepare(
        `INSERT INTO deployments (id, tenant_id, name, agent_id, environment_id, initial_message,
           trigger, hook_token, user_id, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .bind(
        "dep_rl",
        "tenant-a",
        "d",
        "agent_1",
        "env_1",
        "m",
        '{"type":"webhook"}',
        "dhk_ratelimited",
        "user-1",
        now,
        now,
      )
      .run();
    // Inject a rejecting RL_SESSIONS_TENANT binding (the bucket
    // rateLimitDeploymentHook consumes). 429 fires before any session launch,
    // so no sandbox is needed.
    const envWithRl = {
      ...(env as unknown as Record<string, unknown>),
      RL_SESSIONS_TENANT: { limit: async () => ({ success: false }) },
    };
    const res = await hookApp().request(
      "/v1/deployment_hooks/dhk_ratelimited",
      json({}),
      envWithRl,
    );
    expect(res.status).toBe(429);
  });
});
