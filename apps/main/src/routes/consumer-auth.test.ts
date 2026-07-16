// Consumer (end-user) auth realm tests — issue #73.
//
// Covers the acceptance criteria that are testable against real D1 in the
// workers pool:
//   - guest signup mints an anonymous consumer with NO tenant + NO membership
//     row (a consumer is never a tenant owner)
//   - guest -> email upgrade happens in place (same consumer id), so history /
//     associations survive the claim
//   - session token expiry + refresh (old token revoked, new token works)
//   - HARDENING: a consumer session token cannot reach any /v1/* tenant route
//     (presented as x-api-key or as a Bearer authorization header)
//   - creator visibility: GET /v1/publications/:id/users is tenant-scoped and
//     refuses to reveal another tenant's publication users
//
// Uses the real MAIN_DB binding; tables are created up front (migrations are
// not auto-applied in this pool, mirroring test/integration/*).

import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, it, expect } from "vitest";
import { Hono } from "hono";
import consumerAuth from "./consumer-auth";
import consumerAdmin from "./consumer-admin";
import { authMiddleware } from "../auth";

const db = () => (env as unknown as { MAIN_DB: D1Database }).MAIN_DB;

async function setupTables() {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS consumers (
       id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '',
       auth_provider TEXT NOT NULL DEFAULT 'email_otp', tenant_id TEXT,
       created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS magic_links (
       token TEXT PRIMARY KEY, consumer_id TEXT NOT NULL, expires_at TEXT NOT NULL,
       used INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS consumer_sessions (
       token TEXT PRIMARY KEY, consumer_id TEXT NOT NULL, expires_at TEXT NOT NULL,
       created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS consumer_publications (
       id TEXT PRIMARY KEY, consumer_id TEXT NOT NULL, publication_id TEXT NOT NULL,
       tenant_id TEXT NOT NULL, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_consumer_publications_uniq
       ON consumer_publications(consumer_id, publication_id)`,
    `CREATE TABLE IF NOT EXISTS agent_publication (
       id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL,
       agent_version INTEGER NOT NULL DEFAULT 1, slug TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
       visibility TEXT NOT NULL DEFAULT 'public', status TEXT NOT NULL DEFAULT 'live',
       created_at INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS membership (
       user_id TEXT NOT NULL, tenant_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member',
       created_at TEXT NOT NULL DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS sessions (
       id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, metadata TEXT)`,
  ];
  for (const s of stmts) await db().prepare(s).run();
}

async function reset() {
  for (const t of ["consumers", "magic_links", "consumer_sessions", "consumer_publications", "agent_publication", "membership", "sessions"]) {
    await db().prepare(`DELETE FROM ${t}`).run();
  }
}

function publicApp() {
  const app = new Hono();
  app.route("/v1/public", consumerAuth);
  return app;
}

const call = (app: Hono, path: string, init?: RequestInit) =>
  app.request(path, init, env as unknown as Record<string, unknown>);

beforeAll(setupTables);
beforeEach(reset);

describe("guest mode (issue #73)", () => {
  it("mints an anonymous consumer with no tenant and no membership row", async () => {
    const app = publicApp();
    const res = await call(app, "/v1/public/auth/guest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { session_token: string; consumer_id: string; is_guest: boolean };
    expect(body.is_guest).toBe(true);
    expect(body.consumer_id).toMatch(/^cons_/);
    expect(body.session_token).toMatch(/^csess_/);

    const row = await db()
      .prepare("SELECT auth_provider, tenant_id FROM consumers WHERE id = ?")
      .bind(body.consumer_id)
      .first<{ auth_provider: string; tenant_id: string | null }>();
    expect(row?.auth_provider).toBe("guest");
    expect(row?.tenant_id).toBeNull();

    // A consumer is never a tenant owner: no membership row exists at all.
    const members = await db().prepare("SELECT COUNT(*) AS n FROM membership").first<{ n: number }>();
    expect(members?.n).toBe(0);
  });

  it("upgrades a guest to an email consumer in place, preserving the id", async () => {
    const app = publicApp();
    const g = (await (await call(app, "/v1/public/auth/guest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })).json()) as { session_token: string; consumer_id: string };

    const up = await call(app, "/v1/public/auth/upgrade", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${g.session_token}` },
      body: JSON.stringify({ email: "claimed@example.com", name: "Claimed" }),
    });
    expect(up.status).toBe(200);
    const upBody = (await up.json()) as { id: string; email: string; is_guest: boolean };
    expect(upBody.id).toBe(g.consumer_id); // SAME id — history/associations survive
    expect(upBody.email).toBe("claimed@example.com");
    expect(upBody.is_guest).toBe(false);

    // /me now reflects the email identity, still on the same session token.
    const me = (await (await call(app, "/v1/public/auth/me", {
      headers: { authorization: `Bearer ${g.session_token}` },
    })).json()) as { id: string; email: string | null; is_guest: boolean };
    expect(me.id).toBe(g.consumer_id);
    expect(me.email).toBe("claimed@example.com");
    expect(me.is_guest).toBe(false);
  });

  it("refuses to upgrade a guest onto an email another consumer already owns", async () => {
    const app = publicApp();
    await db()
      .prepare("INSERT INTO consumers (id, email, name, auth_provider, created_at, updated_at) VALUES ('cons_other','taken@example.com','Other','email_otp','t','t')")
      .run();
    const g = (await (await call(app, "/v1/public/auth/guest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })).json()) as { session_token: string };

    const up = await call(app, "/v1/public/auth/upgrade", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${g.session_token}` },
      body: JSON.stringify({ email: "taken@example.com" }),
    });
    expect(up.status).toBe(409);
  });
});

describe("session expiry + refresh (issue #73)", () => {
  it("rejects an expired session token and refresh rotates the token", async () => {
    const app = publicApp();
    // Seed a consumer + an ALREADY-EXPIRED session directly.
    await db()
      .prepare("INSERT INTO consumers (id, email, name, auth_provider, created_at, updated_at) VALUES ('cons_exp','exp@example.com','Exp','email_otp','t','t')")
      .run();
    const past = new Date(Date.now() - 1000).toISOString();
    await db()
      .prepare("INSERT INTO consumer_sessions (token, consumer_id, expires_at, created_at) VALUES ('csess_expired','cons_exp',?,?)")
      .bind(past, past)
      .run();

    const expired = await call(app, "/v1/public/auth/me", {
      headers: { authorization: "Bearer csess_expired" },
    });
    expect(expired.status).toBe(401);

    // A fresh (valid) session refreshes into a new token; the old one dies.
    const g = (await (await call(app, "/v1/public/auth/guest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })).json()) as { session_token: string };

    const refreshed = (await (await call(app, "/v1/public/auth/refresh", {
      method: "POST",
      headers: { authorization: `Bearer ${g.session_token}` },
    })).json()) as { session_token: string };
    expect(refreshed.session_token).not.toBe(g.session_token);

    // Old token revoked, new token works.
    const oldRes = await call(app, "/v1/public/auth/me", {
      headers: { authorization: `Bearer ${g.session_token}` },
    });
    expect(oldRes.status).toBe(401);
    const newRes = await call(app, "/v1/public/auth/me", {
      headers: { authorization: `Bearer ${refreshed.session_token}` },
    });
    expect(newRes.status).toBe(200);
  });
});

describe("cross-realm hardening: a consumer token cannot reach /v1/* (issue #73)", () => {
  function tenantApp() {
    // Mirror the real worker: authMiddleware then a protected tenant route.
    const app = new Hono<{ Bindings: never; Variables: { tenant_id: string } }>();
    app.use("*", authMiddleware);
    app.get("/v1/agents", (c) => c.json({ tenant_id: c.var.tenant_id, data: [] }));
    return app;
  }

  it("rejects a consumer session token presented as x-api-key", async () => {
    const app = publicApp();
    const g = (await (await call(app, "/v1/public/auth/guest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })).json()) as { session_token: string };

    const res = await call(tenantApp() as unknown as Hono, "/v1/agents", {
      headers: { "x-api-key": g.session_token },
    });
    expect(res.status).toBe(401);
  });

  it("rejects a consumer session token presented as a Bearer authorization header", async () => {
    const app = publicApp();
    const g = (await (await call(app, "/v1/public/auth/guest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })).json()) as { session_token: string };

    const res = await call(tenantApp() as unknown as Hono, "/v1/agents", {
      headers: { authorization: `Bearer ${g.session_token}` },
    });
    expect(res.status).toBe(401);
  });
});

describe("creator visibility: GET /v1/publications/:id/users (issue #73)", () => {
  function adminApp(tenantId: string) {
    const app = new Hono<{ Bindings: never; Variables: { tenant_id: string } }>();
    app.use("*", async (c, next) => {
      c.set("tenant_id", tenantId);
      await next();
    });
    app.route("/v1/publications", consumerAdmin as unknown as Hono);
    return app as unknown as Hono;
  }

  it("lists a publication's end-users for the owning tenant and hides them from others", async () => {
    const publicApp0 = publicApp();
    await db()
      .prepare("INSERT INTO agent_publication (id, tenant_id, agent_id, slug) VALUES ('pub_1','tenant-a','agent-1','bot')")
      .run();

    const g = (await (await call(publicApp0, "/v1/public/auth/guest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publication_id: "pub_1" }),
    })).json()) as { consumer_id: string; session_token: string };

    // Record the association explicitly through the seen endpoint too.
    await call(publicApp0, "/v1/public/publications/pub_1/seen", {
      method: "POST",
      headers: { authorization: `Bearer ${g.session_token}` },
    });

    // Owning tenant sees the user.
    const owned = await call(adminApp("tenant-a"), "/v1/publications/pub_1/users");
    expect(owned.status).toBe(200);
    const ownedBody = (await owned.json()) as { data: Array<{ consumer_id: string; is_guest: boolean }> };
    expect(ownedBody.data.map((u) => u.consumer_id)).toContain(g.consumer_id);
    expect(ownedBody.data[0].is_guest).toBe(true);

    // A different tenant gets 404 (cannot enumerate another creator's users).
    const other = await call(adminApp("tenant-b"), "/v1/publications/pub_1/users");
    expect(other.status).toBe(404);
  });
});

// Magic-link token delivery (issue #162): the raw token used to be echoed
// straight back in the HTTP response, so anyone could submit a victim's
// email, read the token off the response, and immediately verify into a
// session for that identity — full account takeover with no email-ownership
// check at all. These tests lock down the fix: no token/consumer_id in the
// default response, a real out-of-band email attempt, a narrow dev-only
// escape hatch, and a per-email rate limit.
describe("magic-link token is delivered out-of-band, never echoed (issue #162)", () => {
  it("returns only message + expires_at by default — no token, no consumer_id", async () => {
    const app = publicApp();
    const res = await call(app, "/v1/public/auth/magic-link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "victim@example.com" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.message).toBe("Magic link sent");
    expect(typeof body.expires_at).toBe("string");
    expect(body.token).toBeUndefined();
    expect(body.consumer_id).toBeUndefined();

    // The token IS generated and persisted server-side (for out-of-band
    // email delivery) — just never handed back over HTTP. Prove it's a
    // real, usable token by verifying with it straight from the DB.
    const row = await db()
      .prepare(
        "SELECT token FROM magic_links WHERE consumer_id = (SELECT id FROM consumers WHERE email = ?)",
      )
      .bind("victim@example.com")
      .first<{ token: string }>();
    expect(row?.token).toBeTruthy();

    const verify = await call(app, "/v1/public/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: row!.token }),
    });
    expect(verify.status).toBe(200);
  });

  it("attempts real email dispatch via SEND_EMAIL when the binding is configured", async () => {
    const app = publicApp();
    const sent: Array<{ to: string; subject: string }> = [];
    const emailEnv = {
      ...(env as unknown as Record<string, unknown>),
      SEND_EMAIL: {
        send: async (msg: { to: string; subject: string }) => {
          sent.push({ to: msg.to, subject: msg.subject });
        },
      },
    };
    const res = await app.request(
      "/v1/public/auth/magic-link",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "emailed@example.com" }),
      },
      emailEnv as unknown as Record<string, unknown>,
    );
    expect(res.status).toBe(201);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("emailed@example.com");
  });

  it("echoes the token ONLY when CONSUMER_AUTH_DEV_ECHO_TOKEN is exactly '1' or 'true'", async () => {
    const app = publicApp();

    const devEnv = {
      ...(env as unknown as Record<string, unknown>),
      CONSUMER_AUTH_DEV_ECHO_TOKEN: "1",
    };
    const res = await app.request(
      "/v1/public/auth/magic-link",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "dev-echo@example.com" }),
      },
      devEnv as unknown as Record<string, unknown>,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { token?: string; consumer_id?: string };
    expect(body.token).toBeTruthy();
    // Even in dev-echo mode, consumer_id stays withheld — only the token
    // (needed to drive local /verify testing) is restored.
    expect(body.consumer_id).toBeUndefined();

    // Any other value does NOT enable the escape hatch — this isn't a
    // generic truthy check, it's an exact allow-list of "1" / "true".
    const notEnabledEnv = {
      ...(env as unknown as Record<string, unknown>),
      CONSUMER_AUTH_DEV_ECHO_TOKEN: "yes",
    };
    const res2 = await app.request(
      "/v1/public/auth/magic-link",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "dev-echo-2@example.com" }),
      },
      notEnabledEnv as unknown as Record<string, unknown>,
    );
    const body2 = (await res2.json()) as { token?: string };
    expect(body2.token).toBeUndefined();
  });

  it("rate-limits repeated magic-link requests for the same email", async () => {
    const app = publicApp();
    const limitedEnv = {
      ...(env as unknown as Record<string, unknown>),
      RL_MAGICLINK_EMAIL: { limit: async () => ({ success: false }) },
    };
    const res = await app.request(
      "/v1/public/auth/magic-link",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "flooded@example.com" }),
      },
      limitedEnv as unknown as Record<string, unknown>,
    );
    expect(res.status).toBe(429);

    // Rejected BEFORE any DB write — no consumer/magic_link row created.
    const row = await db()
      .prepare("SELECT id FROM consumers WHERE email = ?")
      .bind("flooded@example.com")
      .first<{ id: string }>();
    expect(row).toBeNull();
  });
});
