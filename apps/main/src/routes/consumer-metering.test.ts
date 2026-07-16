// Publication-state gate coverage for the consumer credits surface
// (issue #210): /v1/public/credits and /v1/public/buy-credits resolve the
// publication behind `agent_id` and must apply the SAME visibility/status
// gate the /p/:slug chat surface applies — private/draft → 404 (hide
// existence), paused → 403 — before reporting a balance or creating a
// Stripe checkout session. Uses the real MAIN_DB binding (workers pool),
// mirroring consumer-auth.test.ts's setup.

import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, afterEach, describe, it, expect } from "vitest";
import { Hono } from "hono";
import consumerAuth from "./consumer-auth";
import consumerMetering from "./consumer-metering";

const db = () => (env as unknown as { MAIN_DB: D1Database }).MAIN_DB;

async function setupTables() {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS consumers (
       id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '',
       auth_provider TEXT NOT NULL DEFAULT 'email_otp', tenant_id TEXT,
       created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS consumer_sessions (
       token TEXT PRIMARY KEY, consumer_id TEXT NOT NULL, expires_at TEXT NOT NULL,
       created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS agent_publication (
       id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL,
       agent_version INTEGER NOT NULL DEFAULT 1, slug TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
       visibility TEXT NOT NULL DEFAULT 'public', status TEXT NOT NULL DEFAULT 'live',
       created_at INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS end_user_balance (
       tenant_id TEXT NOT NULL, end_user_id TEXT NOT NULL, balance INTEGER NOT NULL DEFAULT 0,
       updated_at TEXT NOT NULL, PRIMARY KEY (tenant_id, end_user_id))`,
    `CREATE TABLE IF NOT EXISTS publication_pricing (
       id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, publication_id TEXT NOT NULL,
       mode TEXT NOT NULL DEFAULT 'free', price_amount INTEGER NOT NULL DEFAULT 0,
       currency TEXT NOT NULL DEFAULT 'usd', included_credits INTEGER NOT NULL DEFAULT 0,
       stripe_price_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  ];
  for (const s of stmts) await db().prepare(s).run();
}

async function reset() {
  for (const t of ["consumers", "consumer_sessions", "agent_publication", "end_user_balance", "publication_pricing"]) {
    await db().prepare(`DELETE FROM ${t}`).run();
  }
}

function publicApp() {
  const app = new Hono();
  app.route("/v1/public", consumerAuth);
  app.route("/v1/public", consumerMetering);
  return app;
}

const call = (
  app: Hono,
  path: string,
  init?: RequestInit,
  envOverride?: Record<string, unknown>,
) => app.request(path, init, envOverride ?? (env as unknown as Record<string, unknown>));

async function seedPublication(opts: {
  id: string;
  agentId: string;
  tenantId?: string;
  visibility?: string;
  status?: string;
}) {
  await db()
    .prepare(
      `INSERT INTO agent_publication (id, tenant_id, agent_id, agent_version, slug, visibility, status, created_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, 0)`,
    )
    .bind(
      opts.id,
      opts.tenantId ?? "tenant-a",
      opts.agentId,
      `slug-${opts.id}`,
      opts.visibility ?? "public",
      opts.status ?? "live",
    )
    .run();
}

async function guestToken(app: Hono): Promise<string> {
  const res = await call(app, "/v1/public/auth/guest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const body = (await res.json()) as { session_token: string };
  return body.session_token;
}

beforeAll(setupTables);
beforeEach(reset);

describe("GET /v1/public/credits — publication state gate (issue #210)", () => {
  it("paused publication -> 403", async () => {
    const app = publicApp();
    await seedPublication({ id: "pub_paused", agentId: "agent_paused", status: "paused" });
    const token = await guestToken(app);
    const res = await call(app, "/v1/public/credits?agent_id=agent_paused", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  it("draft publication -> 404", async () => {
    const app = publicApp();
    await seedPublication({ id: "pub_draft", agentId: "agent_draft", status: "draft" });
    const token = await guestToken(app);
    const res = await call(app, "/v1/public/credits?agent_id=agent_draft", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });

  it("private publication -> 404", async () => {
    const app = publicApp();
    await seedPublication({ id: "pub_private", agentId: "agent_private", visibility: "private" });
    const token = await guestToken(app);
    const res = await call(app, "/v1/public/credits?agent_id=agent_private", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });

  it("live public publication -> works", async () => {
    const app = publicApp();
    await seedPublication({ id: "pub_live", agentId: "agent_live" });
    const token = await guestToken(app);
    const res = await call(app, "/v1/public/credits?agent_id=agent_live", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { balance: number; tenant_id: string };
    expect(body.balance).toBe(0);
    expect(body.tenant_id).toBe("tenant-a");
  });
});

describe("POST /v1/public/buy-credits — publication state gate (issue #210)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function stripeEnv(overrides: Record<string, unknown> = {}) {
    return {
      ...(env as unknown as Record<string, unknown>),
      STRIPE_SECRET_KEY: "sk_test_123",
      PUBLIC_BASE_URL: "https://example.test",
      ...overrides,
    };
  }

  it("paused publication -> 403 (never reaches Stripe)", async () => {
    const app = publicApp();
    await seedPublication({ id: "pub_paused2", agentId: "agent_paused2", status: "paused" });
    const token = await guestToken(app);
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}");
    }) as typeof fetch;

    const res = await call(
      app,
      "/v1/public/buy-credits",
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ agent_id: "agent_paused2", credits: 10 }),
      },
      stripeEnv(),
    );
    expect(res.status).toBe(403);
    expect(fetchCalled).toBe(false);
  });

  it("draft publication -> 404 (never reaches Stripe)", async () => {
    const app = publicApp();
    await seedPublication({ id: "pub_draft2", agentId: "agent_draft2", status: "draft" });
    const token = await guestToken(app);
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}");
    }) as typeof fetch;

    const res = await call(
      app,
      "/v1/public/buy-credits",
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ agent_id: "agent_draft2", credits: 10 }),
      },
      stripeEnv(),
    );
    expect(res.status).toBe(404);
    expect(fetchCalled).toBe(false);
  });

  it("private publication -> 404 (never reaches Stripe)", async () => {
    const app = publicApp();
    await seedPublication({ id: "pub_private2", agentId: "agent_private2", visibility: "private" });
    const token = await guestToken(app);
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}");
    }) as typeof fetch;

    const res = await call(
      app,
      "/v1/public/buy-credits",
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ agent_id: "agent_private2", credits: 10 }),
      },
      stripeEnv(),
    );
    expect(res.status).toBe(404);
    expect(fetchCalled).toBe(false);
  });

  it("live publication with a purchasable price -> works, reaches Stripe", async () => {
    const app = publicApp();
    await seedPublication({ id: "pub_live2", agentId: "agent_live2" });
    await db()
      .prepare(
        `INSERT INTO publication_pricing
           (id, tenant_id, publication_id, mode, price_amount, currency, included_credits, stripe_price_id, created_at, updated_at)
         VALUES ('pp_1', 'tenant-a', 'pub_live2', 'per_message', 1, 'credits', 0, 'price_123', 't', 't')`,
      )
      .run();
    const token = await guestToken(app);
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: "cs_test_1", url: "https://checkout.stripe.com/cs_test_1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    const res = await call(
      app,
      "/v1/public/buy-credits",
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ agent_id: "agent_live2", credits: 10 }),
      },
      stripeEnv(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { checkout_url: string; session_id: string };
    expect(body.checkout_url).toBe("https://checkout.stripe.com/cs_test_1");
    expect(body.session_id).toBe("cs_test_1");
  });
});
