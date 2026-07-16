import { Hono } from "hono";
import { z } from "zod";
import { nanoid } from "nanoid";
import { getLogger } from "@duyet/oma-observability";

const log = getLogger("consumer-auth");

interface Env {
  Bindings: {
    MAIN_DB: D1Database;
    BETTER_AUTH_SECRET?: string;
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

const wrapper = new Hono<Env>();

wrapper.post("/v1/public/auth/magic-link", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = consumerSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid email", details: parsed.error.flatten() }, 400);
  }

  const { email, name } = parsed.data;
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
        "INSERT INTO consumers (id, email, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(consumerId, email, name || email.split("@")[0], now, now)
      .run();
  }

  const expiresAt = new Date(Date.now() + MAGIC_LINK_EXPIRY).toISOString();
  await db
    .prepare(
      "INSERT INTO magic_links (token, consumer_id, expires_at, used, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(token, consumerId, expiresAt, false, now)
    .run();

  log.info({ consumer_id: consumerId, email }, "magic link created");

  return c.json({
    message: "Magic link sent",
    token,
    consumer_id: consumerId,
    expires_at: expiresAt,
  }, 201);
});

wrapper.post("/v1/public/auth/verify", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { token } = z.object({ token: z.string().min(1) }).parse(body);

  const db = c.env.MAIN_DB;
  const link = await db
    .prepare("SELECT * FROM magic_links WHERE token = ? AND used = ?")
    .bind(token, false)
    .first<{ token: string; consumer_id: string; expires_at: string; used: boolean; created_at: string }>();

  if (!link) {
    return c.json({ error: "Invalid or expired token" }, 401);
  }

  if (new Date(link.expires_at) < new Date()) {
    return c.json({ error: "Token expired" }, 401);
  }

  await db
    .prepare("UPDATE magic_links SET used = ? WHERE token = ?")
    .bind(true, token)
    .run();

  const sessionToken = `csess_${nanoid(48)}`;
  const sessionExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  await db
    .prepare(
      "INSERT INTO consumer_sessions (token, consumer_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(sessionToken, link.consumer_id, sessionExpires, new Date().toISOString())
    .run();

  return c.json({
    session_token: sessionToken,
    consumer_id: link.consumer_id,
    expires_at: sessionExpires,
  }, 200);
});

wrapper.get("/v1/public/auth/me", async (c) => {
  const auth = c.req.header("authorization");
  if (!auth?.startsWith("Bearer ")) {
    return c.json({ error: "Missing session_token" }, 401);
  }

  const sessionToken = auth.slice(7);
  const db = c.env.MAIN_DB;

  const session = await db
    .prepare("SELECT * FROM consumer_sessions WHERE token = ? AND expires_at > ?")
    .bind(sessionToken, new Date().toISOString())
    .first<{ token: string; consumer_id: string; expires_at: string; created_at: string }>();

  if (!session) {
    return c.json({ error: "Invalid or expired session" }, 401);
  }

  const consumer = await db
    .prepare("SELECT * FROM consumers WHERE id = ?")
    .bind(session.consumer_id)
    .first<{ id: string; email: string; name: string }>();

  if (!consumer) {
    return c.json({ error: "Consumer not found" }, 404);
  }

  return c.json({
    id: consumer.id,
    email: consumer.email,
    name: consumer.name,
  }, 200);
});

export default wrapper;
