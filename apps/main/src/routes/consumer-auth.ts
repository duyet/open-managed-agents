import { Hono } from "hono";
import { z } from "zod";
import { nanoid } from "nanoid";
import { getLogger } from "@duyet/oma-observability";
import { sendEmail } from "../auth-config";
import { rateLimitMagicLinkEmail } from "../rate-limit";

const log = getLogger("consumer-auth");

interface Env {
  Bindings: {
    MAIN_DB: D1Database;
    BETTER_AUTH_SECRET?: string;
    SEND_EMAIL?: SendEmail;
    RL_MAGICLINK_EMAIL?: RateLimit;
    /** Dev/test escape hatch (issue #162) — ONLY when exactly "1" or "true"
     *  does /auth/magic-link echo the raw token back in the response body.
     *  Default (unset/anything else): token is never returned, only
     *  delivered via email. Never enable in production. */
    CONSUMER_AUTH_DEV_ECHO_TOKEN?: string;
  };
  Variables: {
    consumer_id?: string;
  };
}

const consumerSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(100).optional(),
});

const MAGIC_LINK_EXPIRY = 15 * 60 * 1000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface ConsumerSessionRow {
  token: string;
  consumer_id: string;
  expires_at: string;
  created_at: string;
}

/**
 * Resolve a consumer bearer token to its (unexpired) session row. Shared by
 * /me, /refresh, /upgrade, and consumer-metering's requireConsumer guard so
 * the expiry check lives in exactly one place. Returns null for a
 * missing/expired token (the caller decides the status code).
 */
export async function resolveConsumerSession(
  db: D1Database,
  token: string,
): Promise<ConsumerSessionRow | null> {
  const row = await db
    .prepare("SELECT * FROM consumer_sessions WHERE token = ? AND expires_at > ?")
    .bind(token, new Date().toISOString())
    .first<ConsumerSessionRow>();
  return row ?? null;
}

function bearer(c: import("hono").Context<Env>): string | null {
  const auth = c.req.header("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  return auth.slice(7);
}

async function issueSession(
  db: D1Database,
  consumerId: string,
): Promise<{ token: string; expires_at: string }> {
  const token = `csess_${nanoid(48)}`;
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await db
    .prepare(
      "INSERT INTO consumer_sessions (token, consumer_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(token, consumerId, expiresAt, new Date().toISOString())
    .run();
  return { token, expires_at: expiresAt };
}

/** Resolve the owning tenant for a publication id (public, no auth). */
async function tenantForPublication(
  db: D1Database,
  publicationId: string,
): Promise<string | null> {
  const row = await db
    .prepare("SELECT tenant_id FROM agent_publication WHERE id = ?")
    .bind(publicationId)
    .first<{ tenant_id: string }>();
  return row?.tenant_id ?? null;
}

/** Transactional email body for a consumer magic-link (issue #162). No
 *  clickable callback page exists yet for the public chat surface, so the
 *  token is presented as a copyable sign-in code — the recipient (or the
 *  publication's UI, once built) submits it to POST /v1/public/auth/verify. */
function magicLinkEmailHtml(token: string): string {
  return [
    '<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:32px">',
    '<h2 style="margin:0 0 16px">Your sign-in code</h2>',
    `<p style="font-size:16px;letter-spacing:1px;font-weight:bold;margin:24px 0;word-break:break-all">${token}</p>`,
    '<p style="color:#666;font-size:14px">This code expires in 15 minutes. If you did not request this, ignore this email.</p>',
    "</div>",
  ].join("");
}

/** Upsert a consumer <-> publication association (first-seen / last-seen). */
async function recordConsumerPublication(
  db: D1Database,
  consumerId: string,
  publicationId: string,
  tenantId: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO consumer_publications (id, consumer_id, publication_id, tenant_id, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(consumer_id, publication_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
    )
    .bind(`cpub_${nanoid(24)}`, consumerId, publicationId, tenantId, now, now)
    .run();
}

const wrapper = new Hono<Env>();

wrapper.post("/auth/magic-link", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = consumerSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid email", details: parsed.error.flatten() }, 400);
  }

  const { email, name } = parsed.data;

  // Anti-spam-the-victim: an attacker who doesn't own `email` can otherwise
  // hammer this endpoint to flood the real owner's inbox. Reject BEFORE any
  // DB write. Soft-passes when RL_MAGICLINK_EMAIL isn't bound (dev/test).
  if (await rateLimitMagicLinkEmail(c.env.RL_MAGICLINK_EMAIL, email)) {
    return c.json(
      { error: "Too many magic link requests — please wait a bit and try again" },
      429,
    );
  }

  const db = c.env.MAIN_DB;
  const now = new Date().toISOString();
  const token = nanoid(48);

  let consumerId: string;
  const existing = await db
    .prepare("SELECT id FROM consumers WHERE email = ?")
    .bind(email)
    .first<{ id: string }>();

  if (existing) {
    consumerId = existing.id;
  } else {
    consumerId = `cons_${nanoid(24)}`;
    await db
      .prepare(
        "INSERT INTO consumers (id, email, name, auth_provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(consumerId, email, name || email.split("@")[0], "email_otp", now, now)
      .run();
  }

  const expiresAt = new Date(Date.now() + MAGIC_LINK_EXPIRY).toISOString();
  await db
    .prepare(
      "INSERT INTO magic_links (token, consumer_id, expires_at, used, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(token, consumerId, expiresAt, false, now)
    .run();

  // Deliver the token out-of-band via email (issue #162) — it must never be
  // echoed back in the HTTP response, since that lets anyone impersonate any
  // email address. A transient send failure is logged, not fatal: the token
  // is already persisted and the caller can retry (rate-limited above).
  try {
    await sendEmail(
      c.env,
      email,
      "Your sign-in code — oma",
      magicLinkEmailHtml(token),
      `Your sign-in code: ${token} (expires in 15 minutes)`,
    );
  } catch (err) {
    log.warn({ consumer_id: consumerId, email, err }, "magic link email dispatch failed");
  }

  log.info({ consumer_id: consumerId, email }, "magic link created");

  // Dev/test escape hatch ONLY — see the field doc on CONSUMER_AUTH_DEV_ECHO_TOKEN.
  const devEcho =
    c.env.CONSUMER_AUTH_DEV_ECHO_TOKEN === "1" || c.env.CONSUMER_AUTH_DEV_ECHO_TOKEN === "true";

  return c.json(
    {
      message: "Magic link sent",
      expires_at: expiresAt,
      ...(devEcho ? { token } : {}),
    },
    201,
  );
});

wrapper.post("/auth/verify", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { token } = z.object({ token: z.string().min(1) }).parse(body);

  const db = c.env.MAIN_DB;
  const link = await db
    .prepare("SELECT * FROM magic_links WHERE token = ? AND used = ?")
    .bind(token, false)
    .first<{
      token: string;
      consumer_id: string;
      expires_at: string;
      used: boolean;
      created_at: string;
    }>();

  if (!link) {
    return c.json({ error: "Invalid or expired token" }, 401);
  }

  if (new Date(link.expires_at) < new Date()) {
    return c.json({ error: "Token expired" }, 401);
  }

  await db.prepare("UPDATE magic_links SET used = ? WHERE token = ?").bind(true, token).run();

  const { token: sessionToken, expires_at } = await issueSession(db, link.consumer_id);

  return c.json(
    {
      session_token: sessionToken,
      consumer_id: link.consumer_id,
      expires_at,
    },
    200,
  );
});

// Guest mode (issue #73): mint an anonymous consumer + session so a visitor
// can start chatting on a public publication before committing to an account.
// The returned session_token is the stable, claimable anonymous identity —
// POST /auth/upgrade later attaches an email to the SAME consumer id, so the
// guest's associations/history survive the claim. No tenant, no membership.
wrapper.post("/auth/guest", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { publication_id } = z.object({ publication_id: z.string().optional() }).parse(body);

  const db = c.env.MAIN_DB;
  const now = new Date().toISOString();
  const consumerId = `cons_${nanoid(24)}`;
  // email is NOT NULL UNIQUE in the schema; guests get a unique sentinel that
  // can't collide with a real address (upgrade overwrites it with the real one).
  const sentinelEmail = `guest_${consumerId}@guest.local`;

  let tenantId: string | null = null;
  if (publication_id) {
    tenantId = await tenantForPublication(db, publication_id);
  }

  await db
    .prepare(
      "INSERT INTO consumers (id, email, name, auth_provider, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(consumerId, sentinelEmail, "Guest", "guest", tenantId, now, now)
    .run();

  if (publication_id && tenantId) {
    await recordConsumerPublication(db, consumerId, publication_id, tenantId);
  }

  const { token, expires_at } = await issueSession(db, consumerId);
  log.info({ consumer_id: consumerId, publication_id }, "guest consumer created");

  return c.json(
    {
      session_token: token,
      consumer_id: consumerId,
      is_guest: true,
      expires_at,
    },
    201,
  );
});

// Upgrade a guest to a real (email) consumer IN PLACE (issue #73): keeps the
// same consumer id so the in-progress conversation + publication associations
// carry over. Requires a valid guest session bearer token.
wrapper.post("/auth/upgrade", async (c) => {
  const token = bearer(c);
  if (!token) return c.json({ error: "Missing session_token" }, 401);

  const db = c.env.MAIN_DB;
  const session = await resolveConsumerSession(db, token);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);

  const body = await c.req.json().catch(() => ({}));
  const parsed = consumerSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid email", details: parsed.error.flatten() }, 400);
  }
  const { email, name } = parsed.data;

  const current = await db
    .prepare("SELECT id, email, auth_provider FROM consumers WHERE id = ?")
    .bind(session.consumer_id)
    .first<{ id: string; email: string; auth_provider: string }>();
  if (!current) return c.json({ error: "Consumer not found" }, 404);

  if (current.auth_provider !== "guest") {
    return c.json({ error: "Consumer already has an account" }, 409);
  }

  // Refuse to silently merge into a different existing account.
  const taken = await db
    .prepare("SELECT id FROM consumers WHERE email = ? AND id != ?")
    .bind(email, session.consumer_id)
    .first<{ id: string }>();
  if (taken) {
    return c.json({ error: "Email already registered" }, 409);
  }

  const now = new Date().toISOString();
  await db
    .prepare("UPDATE consumers SET email = ?, name = ?, auth_provider = ?, updated_at = ? WHERE id = ?")
    .bind(email, name || email.split("@")[0], "email_otp", now, session.consumer_id)
    .run();

  log.info({ consumer_id: session.consumer_id, email }, "guest upgraded to email consumer");

  return c.json(
    {
      id: session.consumer_id,
      email,
      name: name || email.split("@")[0],
      is_guest: false,
    },
    200,
  );
});

// Refresh a consumer session (issue #73): exchange a still-valid bearer token
// for a fresh one with a rolled-forward expiry, and revoke the old token.
wrapper.post("/auth/refresh", async (c) => {
  const token = bearer(c);
  if (!token) return c.json({ error: "Missing session_token" }, 401);

  const db = c.env.MAIN_DB;
  const session = await resolveConsumerSession(db, token);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);

  const issued = await issueSession(db, session.consumer_id);
  await db.prepare("DELETE FROM consumer_sessions WHERE token = ?").bind(token).run();

  return c.json(
    {
      session_token: issued.token,
      consumer_id: session.consumer_id,
      expires_at: issued.expires_at,
    },
    200,
  );
});

wrapper.get("/auth/me", async (c) => {
  const token = bearer(c);
  if (!token) return c.json({ error: "Missing session_token" }, 401);

  const db = c.env.MAIN_DB;
  const session = await resolveConsumerSession(db, token);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);

  const consumer = await db
    .prepare("SELECT * FROM consumers WHERE id = ?")
    .bind(session.consumer_id)
    .first<{ id: string; email: string; name: string; auth_provider: string }>();

  if (!consumer) {
    return c.json({ error: "Consumer not found" }, 404);
  }

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
// creator's published agents and creators can list their end-users. The
// public chat page calls this once a consumer (guest or email) opens a
// publication.
wrapper.post("/publications/:pid/seen", async (c) => {
  const token = bearer(c);
  if (!token) return c.json({ error: "Missing session_token" }, 401);

  const db = c.env.MAIN_DB;
  const session = await resolveConsumerSession(db, token);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);

  const publicationId = c.req.param("pid");
  const tenantId = await tenantForPublication(db, publicationId);
  if (!tenantId) return c.json({ error: "Publication not found" }, 404);

  await recordConsumerPublication(db, session.consumer_id, publicationId, tenantId);
  return c.json({ ok: true }, 200);
});

export default wrapper;
