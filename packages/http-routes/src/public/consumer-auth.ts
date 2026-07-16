// Consumer (end-user) auth realm — runtime-neutral factory (issue #226).
//
// The public chat surface (/p/:slug) authenticates end-users with a custom
// magic-link + guest flow, distinct from tenant owners — a consumer never gets
// a `membership` row. This file owns the handler logic; each runtime (the
// Cloudflare worker apps/main, the self-host Node server apps/main-node) mounts
// it with its own storage/email/rate-limit ports:
//
//   - `store`  — a ConsumerAuthStore over the runtime-agnostic SqlClient, so
//     the exact same SQL runs on D1, better-sqlite3, and postgres. CF wraps
//     env.MAIN_DB via sqlClientFromD1; Node passes its process-global sql.
//   - `sendEmail` — delivers the magic-link out-of-band; both runtimes log the
//     token server-side when no mail provider is configured (issue #162: the
//     token is NEVER echoed in the HTTP response outside the dev escape hatch).
//   - `rateLimitMagicLinkEmail` — anti-spam-the-victim gate, per email.
//
// Routes (mounted at /v1/public): POST /auth/magic-link, /auth/verify,
// /auth/guest, /auth/upgrade, /auth/refresh; GET /auth/me; POST
// /publications/:pid/seen.

import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { nanoid } from "nanoid";
import { getLogger } from "@duyet/oma-observability";
import type { SqlClient } from "@duyet/oma-sql-client";

const log = getLogger("consumer-auth");

const consumerSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(100).optional(),
});

const MAGIC_LINK_EXPIRY = 15 * 60 * 1000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface ConsumerSessionRow {
  token: string;
  consumer_id: string;
  expires_at: string;
  created_at?: string;
}

interface ConsumerRow {
  id: string;
  email: string;
  name: string;
  auth_provider: string;
}

interface MagicLinkRow {
  token: string;
  consumer_id: string;
  expires_at: string;
}

/**
 * Storage port for the consumer realm. Every method maps 1:1 to a query the
 * handlers below run. Implemented once over SqlClient
 * (`createSqlConsumerAuthStore`) — the D1-style bind chain is identical across
 * backends, and the one gotcha (`used` is bound as the integer 0/1, never a JS
 * boolean, since better-sqlite3 rejects boolean binds) lives in that adapter.
 */
export interface ConsumerAuthStore {
  findConsumerByEmail(email: string): Promise<{ id: string } | null>;
  createConsumer(row: {
    id: string;
    email: string;
    name: string;
    authProvider: string;
    tenantId: string | null;
    now: string;
  }): Promise<void>;
  getConsumerById(id: string): Promise<ConsumerRow | null>;
  updateConsumerIdentity(row: {
    id: string;
    email: string;
    name: string;
    authProvider: string;
    now: string;
  }): Promise<void>;
  findConsumerByEmailExcludingId(email: string, id: string): Promise<{ id: string } | null>;
  createMagicLink(row: { token: string; consumerId: string; expiresAt: string; now: string }): Promise<void>;
  findUnusedMagicLink(token: string): Promise<MagicLinkRow | null>;
  markMagicLinkUsed(token: string): Promise<void>;
  createConsumerSession(row: { token: string; consumerId: string; expiresAt: string; now: string }): Promise<void>;
  resolveConsumerSession(token: string): Promise<ConsumerSessionRow | null>;
  deleteConsumerSession(token: string): Promise<void>;
  tenantForPublication(publicationId: string): Promise<string | null>;
  upsertConsumerPublication(row: {
    id: string;
    consumerId: string;
    publicationId: string;
    tenantId: string;
    now: string;
  }): Promise<void>;
}

/** ConsumerAuthStore over any SqlClient (D1 / better-sqlite3 / postgres). */
export function createSqlConsumerAuthStore(sql: SqlClient): ConsumerAuthStore {
  return {
    findConsumerByEmail(email) {
      return sql.prepare("SELECT id FROM consumers WHERE email = ?").bind(email).first<{ id: string }>();
    },
    async createConsumer(row) {
      await sql
        .prepare(
          "INSERT INTO consumers (id, email, name, auth_provider, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(row.id, row.email, row.name, row.authProvider, row.tenantId, row.now, row.now)
        .run();
    },
    getConsumerById(id) {
      return sql
        .prepare("SELECT id, email, name, auth_provider FROM consumers WHERE id = ?")
        .bind(id)
        .first<ConsumerRow>();
    },
    async updateConsumerIdentity(row) {
      await sql
        .prepare("UPDATE consumers SET email = ?, name = ?, auth_provider = ?, updated_at = ? WHERE id = ?")
        .bind(row.email, row.name, row.authProvider, row.now, row.id)
        .run();
    },
    findConsumerByEmailExcludingId(email, id) {
      return sql
        .prepare("SELECT id FROM consumers WHERE email = ? AND id != ?")
        .bind(email, id)
        .first<{ id: string }>();
    },
    async createMagicLink(row) {
      await sql
        .prepare("INSERT INTO magic_links (token, consumer_id, expires_at, used, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(row.token, row.consumerId, row.expiresAt, 0, row.now)
        .run();
    },
    findUnusedMagicLink(token) {
      return sql
        .prepare("SELECT token, consumer_id, expires_at FROM magic_links WHERE token = ? AND used = ?")
        .bind(token, 0)
        .first<MagicLinkRow>();
    },
    async markMagicLinkUsed(token) {
      await sql.prepare("UPDATE magic_links SET used = ? WHERE token = ?").bind(1, token).run();
    },
    async createConsumerSession(row) {
      await sql
        .prepare("INSERT INTO consumer_sessions (token, consumer_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
        .bind(row.token, row.consumerId, row.expiresAt, row.now)
        .run();
    },
    resolveConsumerSession(token) {
      return sql
        .prepare(
          "SELECT token, consumer_id, expires_at, created_at FROM consumer_sessions WHERE token = ? AND expires_at > ?",
        )
        .bind(token, new Date().toISOString())
        .first<ConsumerSessionRow>();
    },
    async deleteConsumerSession(token) {
      await sql.prepare("DELETE FROM consumer_sessions WHERE token = ?").bind(token).run();
    },
    async tenantForPublication(publicationId) {
      const row = await sql
        .prepare("SELECT tenant_id FROM agent_publication WHERE id = ?")
        .bind(publicationId)
        .first<{ tenant_id: string }>();
      return row?.tenant_id ?? null;
    },
    async upsertConsumerPublication(row) {
      await sql
        .prepare(
          `INSERT INTO consumer_publications (id, consumer_id, publication_id, tenant_id, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (consumer_id, publication_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
        )
        .bind(row.id, row.consumerId, row.publicationId, row.tenantId, row.now, row.now)
        .run();
    },
  };
}

/** Subject line for the magic-link email. */
export const MAGIC_LINK_EMAIL_SUBJECT = "Your sign-in code — oma";

/** Transactional email body for a consumer magic-link (issue #162). No
 *  clickable callback page exists yet for the public chat surface, so the
 *  token is presented as a copyable sign-in code — the recipient (or the
 *  publication's UI, once built) submits it to POST /v1/public/auth/verify. */
export function magicLinkEmailHtml(token: string): string {
  return [
    '<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:32px">',
    '<h2 style="margin:0 0 16px">Your sign-in code</h2>',
    `<p style="font-size:16px;letter-spacing:1px;font-weight:bold;margin:24px 0;word-break:break-all">${token}</p>`,
    '<p style="color:#666;font-size:14px">This code expires in 15 minutes. If you did not request this, ignore this email.</p>',
    "</div>",
  ].join("");
}

/** Plain-text fallback body for the magic-link email. */
export function magicLinkEmailText(token: string): string {
  return `Your sign-in code: ${token} (expires in 15 minutes)`;
}

export interface ConsumerAuthEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface ConsumerAuthRoutesDeps {
  /** Resolve the store for this request. Static (Node) or per-request (CF,
   *  which builds it from the request-scoped D1 binding). */
  store: ConsumerAuthStore | ((c: Context) => ConsumerAuthStore);
  /** Deliver the magic-link email. Runtime maps it to its mailer and logs the
   *  token server-side when no provider is configured. Omit to skip delivery
   *  entirely (token still persisted; useful in tests). */
  sendEmail?: (c: Context, msg: ConsumerAuthEmail) => Promise<void> | void;
  /** Rate-limit magic-link requests per email. Return true to reject (429). */
  rateLimitMagicLinkEmail?: (c: Context, email: string) => Promise<boolean>;
  /** Dev/test escape hatch: when it returns true, the raw token is echoed in
   *  the magic-link response body. Never enable in production (issue #162). */
  devEchoToken?: (c: Context) => boolean;
}

function resolveStore(arg: ConsumerAuthRoutesDeps["store"], c: Context): ConsumerAuthStore {
  return typeof arg === "function" ? arg(c) : arg;
}

function bearer(c: Context): string | null {
  const auth = c.req.header("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  return auth.slice(7);
}

async function issueSession(
  store: ConsumerAuthStore,
  consumerId: string,
): Promise<{ token: string; expires_at: string }> {
  const token = `csess_${nanoid(48)}`;
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await store.createConsumerSession({
    token,
    consumerId,
    expiresAt,
    now: new Date().toISOString(),
  });
  return { token, expires_at: expiresAt };
}

export function buildConsumerAuthRoutes(deps: ConsumerAuthRoutesDeps) {
  const app = new Hono();

  app.post("/auth/magic-link", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = consumerSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid email", details: parsed.error.flatten() }, 400);
    }
    const { email, name } = parsed.data;

    // Anti-spam-the-victim: an attacker who doesn't own `email` can otherwise
    // hammer this endpoint to flood the real owner's inbox. Reject BEFORE any
    // DB write. Soft-passes when no rate-limiter is wired (dev/test).
    if (deps.rateLimitMagicLinkEmail && (await deps.rateLimitMagicLinkEmail(c, email))) {
      return c.json({ error: "Too many magic link requests — please wait a bit and try again" }, 429);
    }

    const store = resolveStore(deps.store, c);
    const now = new Date().toISOString();
    const token = nanoid(48);

    let consumerId: string;
    const existing = await store.findConsumerByEmail(email);
    if (existing) {
      consumerId = existing.id;
    } else {
      consumerId = `cons_${nanoid(24)}`;
      await store.createConsumer({
        id: consumerId,
        email,
        name: name || email.split("@")[0],
        authProvider: "email_otp",
        tenantId: null,
        now,
      });
    }

    const expiresAt = new Date(Date.now() + MAGIC_LINK_EXPIRY).toISOString();
    await store.createMagicLink({ token, consumerId, expiresAt, now });

    // Deliver the token out-of-band (issue #162) — it must never be echoed in
    // the HTTP response, since that lets anyone impersonate any email address.
    // A transient send failure is logged, not fatal: the token is already
    // persisted and the caller can retry (rate-limited above).
    if (deps.sendEmail) {
      try {
        await deps.sendEmail(c, {
          to: email,
          subject: MAGIC_LINK_EMAIL_SUBJECT,
          html: magicLinkEmailHtml(token),
          text: magicLinkEmailText(token),
        });
      } catch (err) {
        log.warn({ consumer_id: consumerId, email, err }, "magic link email dispatch failed");
      }
    }

    log.info({ consumer_id: consumerId, email }, "magic link created");

    const devEcho = deps.devEchoToken ? deps.devEchoToken(c) : false;
    return c.json(
      {
        message: "Magic link sent",
        expires_at: expiresAt,
        ...(devEcho ? { token } : {}),
      },
      201,
    );
  });

  app.post("/auth/verify", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { token } = z.object({ token: z.string().min(1) }).parse(body);

    const store = resolveStore(deps.store, c);
    const link = await store.findUnusedMagicLink(token);
    if (!link) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }
    if (new Date(link.expires_at) < new Date()) {
      return c.json({ error: "Token expired" }, 401);
    }

    await store.markMagicLinkUsed(token);
    const { token: sessionToken, expires_at } = await issueSession(store, link.consumer_id);

    return c.json({ session_token: sessionToken, consumer_id: link.consumer_id, expires_at }, 200);
  });

  // Guest mode (issue #73): mint an anonymous consumer + session so a visitor
  // can start chatting on a public publication before committing to an account.
  // The returned session_token is the stable, claimable anonymous identity —
  // POST /auth/upgrade later attaches an email to the SAME consumer id.
  app.post("/auth/guest", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { publication_id } = z.object({ publication_id: z.string().optional() }).parse(body);

    const store = resolveStore(deps.store, c);
    const now = new Date().toISOString();
    const consumerId = `cons_${nanoid(24)}`;
    // email is NOT NULL UNIQUE in the schema; guests get a unique sentinel that
    // can't collide with a real address (upgrade overwrites it with the real one).
    const sentinelEmail = `guest_${consumerId}@guest.local`;

    let tenantId: string | null = null;
    if (publication_id) {
      tenantId = await store.tenantForPublication(publication_id);
    }

    await store.createConsumer({
      id: consumerId,
      email: sentinelEmail,
      name: "Guest",
      authProvider: "guest",
      tenantId,
      now,
    });

    if (publication_id && tenantId) {
      await store.upsertConsumerPublication({
        id: `cpub_${nanoid(24)}`,
        consumerId,
        publicationId: publication_id,
        tenantId,
        now,
      });
    }

    const { token, expires_at } = await issueSession(store, consumerId);
    log.info({ consumer_id: consumerId, publication_id }, "guest consumer created");

    return c.json({ session_token: token, consumer_id: consumerId, is_guest: true, expires_at }, 201);
  });

  // Upgrade a guest to a real (email) consumer IN PLACE (issue #73): keeps the
  // same consumer id so the in-progress conversation + publication associations
  // carry over. Requires a valid guest session bearer token.
  app.post("/auth/upgrade", async (c) => {
    const token = bearer(c);
    if (!token) return c.json({ error: "Missing session_token" }, 401);

    const store = resolveStore(deps.store, c);
    const session = await store.resolveConsumerSession(token);
    if (!session) return c.json({ error: "Invalid or expired session" }, 401);

    const body = await c.req.json().catch(() => ({}));
    const parsed = consumerSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid email", details: parsed.error.flatten() }, 400);
    }
    const { email, name } = parsed.data;

    const current = await store.getConsumerById(session.consumer_id);
    if (!current) return c.json({ error: "Consumer not found" }, 404);

    if (current.auth_provider !== "guest") {
      return c.json({ error: "Consumer already has an account" }, 409);
    }

    // Refuse to silently merge into a different existing account.
    const taken = await store.findConsumerByEmailExcludingId(email, session.consumer_id);
    if (taken) {
      return c.json({ error: "Email already registered" }, 409);
    }

    const now = new Date().toISOString();
    await store.updateConsumerIdentity({
      id: session.consumer_id,
      email,
      name: name || email.split("@")[0],
      authProvider: "email_otp",
      now,
    });

    log.info({ consumer_id: session.consumer_id, email }, "guest upgraded to email consumer");

    return c.json({ id: session.consumer_id, email, name: name || email.split("@")[0], is_guest: false }, 200);
  });

  // Refresh a consumer session (issue #73): exchange a still-valid bearer token
  // for a fresh one with a rolled-forward expiry, and revoke the old token.
  app.post("/auth/refresh", async (c) => {
    const token = bearer(c);
    if (!token) return c.json({ error: "Missing session_token" }, 401);

    const store = resolveStore(deps.store, c);
    const session = await store.resolveConsumerSession(token);
    if (!session) return c.json({ error: "Invalid or expired session" }, 401);

    const issued = await issueSession(store, session.consumer_id);
    await store.deleteConsumerSession(token);

    return c.json({ session_token: issued.token, consumer_id: session.consumer_id, expires_at: issued.expires_at }, 200);
  });

  app.get("/auth/me", async (c) => {
    const token = bearer(c);
    if (!token) return c.json({ error: "Missing session_token" }, 401);

    const store = resolveStore(deps.store, c);
    const session = await store.resolveConsumerSession(token);
    if (!session) return c.json({ error: "Invalid or expired session" }, 401);

    const consumer = await store.getConsumerById(session.consumer_id);
    if (!consumer) return c.json({ error: "Consumer not found" }, 404);

    const isGuest = consumer.auth_provider === "guest";
    return c.json(
      {
        id: consumer.id,
        email: isGuest ? null : consumer.email,
        name: consumer.name,
        is_guest: isGuest,
      },
      200,
    );
  });

  // Record a consumer's use of a publication (issue #73): upserts the
  // first-seen / last-seen association so a consumer can span several of a
  // creator's published agents and creators can list their end-users.
  app.post("/publications/:pid/seen", async (c) => {
    const token = bearer(c);
    if (!token) return c.json({ error: "Missing session_token" }, 401);

    const store = resolveStore(deps.store, c);
    const session = await store.resolveConsumerSession(token);
    if (!session) return c.json({ error: "Invalid or expired session" }, 401);

    const publicationId = c.req.param("pid");
    const tenantId = await store.tenantForPublication(publicationId);
    if (!tenantId) return c.json({ error: "Publication not found" }, 404);

    await store.upsertConsumerPublication({
      id: `cpub_${nanoid(24)}`,
      consumerId: session.consumer_id,
      publicationId,
      tenantId,
      now: new Date().toISOString(),
    });
    return c.json({ ok: true }, 200);
  });

  return app;
}
