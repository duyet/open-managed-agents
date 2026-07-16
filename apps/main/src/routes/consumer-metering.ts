import { Hono } from "hono";
import { z } from "zod";
import { nanoid } from "nanoid";
import { getLogger } from "@duyet/oma-observability";
import { resolveConsumerSession } from "./consumer-auth";

const log = getLogger("consumer-metering");

interface Env {
  Bindings: {
    MAIN_DB: D1Database;
    STRIPE_SECRET_KEY?: string;
    STRIPE_PRICE_ID?: string;
  };
  Variables: {
    consumer_id: string;
  };
}

const CREDIT_COST_PER_MESSAGE = 1;

const wrapper = new Hono<Env>();

function requireConsumer() {
  return async (c: import("hono").Context<Env>, next: () => Promise<void>) => {
    const auth = c.req.header("authorization");
    if (!auth?.startsWith("Bearer ")) {
      return c.json({ error: "Missing session_token" }, 401);
    }

    const sessionToken = auth.slice(7);
    const session = await resolveConsumerSession(c.env.MAIN_DB, sessionToken);

    if (!session) {
      return c.json({ error: "Invalid or expired session" }, 401);
    }

    c.set("consumer_id", session.consumer_id);
    await next();
  };
}

wrapper.get("/credits", requireConsumer(), async (c) => {
  const consumerId = c.var.consumer_id;
  const agentId = c.req.query("agent_id");
  const db = c.env.MAIN_DB;

  let sql = "SELECT * FROM consumer_credits WHERE consumer_id = ?";
  const params: unknown[] = [consumerId];
  if (agentId) {
    sql += " AND agent_id = ?";
    params.push(agentId);
  }

  const rows = await db.prepare(sql).bind(...params).all();
  return c.json({ data: rows.results }, 200);
});

wrapper.post("/credits/deduct", requireConsumer(), async (c) => {
  const consumerId = c.var.consumer_id;
  const body = await c.req.json().catch(() => ({}));
  const { agent_id, amount = CREDIT_COST_PER_MESSAGE } = z
    .object({ agent_id: z.string(), amount: z.number().int().positive().optional() })
    .parse(body);

  const db = c.env.MAIN_DB;

  const credit = await db
    .prepare("SELECT * FROM consumer_credits WHERE consumer_id = ? AND agent_id = ?")
    .bind(consumerId, agent_id)
    .first<{ id: string; credits_remaining: number; updated_at: string }>();

  if (!credit || credit.credits_remaining < amount) {
    return c.json({
      error: "Insufficient credits",
      credits_remaining: credit?.credits_remaining ?? 0,
      cost: amount,
    }, 402);
  }

  const newBalance = credit.credits_remaining - amount;
  await db
    .prepare("UPDATE consumer_credits SET credits_remaining = ?, updated_at = ? WHERE id = ?")
    .bind(newBalance, new Date().toISOString(), credit.id)
    .run();

  await db
    .prepare(
      "INSERT INTO credit_usage_log (id, consumer_id, agent_id, credits_used, balance_after, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(`cul_${nanoid(24)}`, consumerId, agent_id, amount, newBalance, new Date().toISOString())
    .run();

  log.info({ consumer_id: consumerId, agent_id, amount, new_balance: newBalance }, "credits deducted");

  return c.json({
    credits_remaining: newBalance,
    credits_used: amount,
  }, 200);
});

wrapper.post("/credits/topup", requireConsumer(), async (c) => {
  const consumerId = c.var.consumer_id;
  const body = await c.req.json().catch(() => ({}));
  const { agent_id, amount } = z
    .object({ agent_id: z.string(), amount: z.number().int().positive() })
    .parse(body);

  const db = c.env.MAIN_DB;

  const existing = await db
    .prepare("SELECT * FROM consumer_credits WHERE consumer_id = ? AND agent_id = ?")
    .bind(consumerId, agent_id)
    .first<{ id: string; credits_remaining: number }>();

  if (existing) {
    const newBalance = existing.credits_remaining + amount;
    await db
      .prepare("UPDATE consumer_credits SET credits_remaining = ?, updated_at = ? WHERE id = ?")
      .bind(newBalance, new Date().toISOString(), existing.id)
      .run();
  } else {
    await db
      .prepare(
        "INSERT INTO consumer_credits (id, consumer_id, agent_id, credits_remaining, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(`ccr_${nanoid(24)}`, consumerId, agent_id, amount, new Date().toISOString(), new Date().toISOString())
      .run();
  }

  log.info({ consumer_id: consumerId, agent_id, amount }, "credits topped up");

  return c.json({ credits_added: amount }, 200);
});

wrapper.post("/buy-credits", requireConsumer(), async (c) => {
  const consumerId = c.var.consumer_id;
  const body = await c.req.json().catch(() => ({}));
  const { agent_id, credits } = z
    .object({ agent_id: z.string(), credits: z.number().int().positive() })
    .parse(body);

  const stripeKey = c.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    return c.json({ error: "Stripe not configured" }, 501);
  }

  const priceId = c.env.STRIPE_PRICE_ID || "price_1_credits_starter";

  const url = "https://api.stripe.com/v1/checkout/sessions";
  const stripeRes = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${stripeKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      "mode": "payment",
      "success_url": `${c.req.header("origin") || "http://localhost:8787"}/credits/success?session_id={CHECKOUT_SESSION_ID}`,
      "cancel_url": `${c.req.header("origin") || "http://localhost:8787"}/credits/cancel`,
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": String(credits),
      "client_reference_id": consumerId,
      "metadata[consumer_id]": consumerId,
      "metadata[agent_id]": agent_id,
      "metadata[credits]": String(credits),
    }),
  });

  if (!stripeRes.ok) {
    const err = await stripeRes.text().catch(() => "stripe error");
    log.error({ consumer_id: consumerId, status: stripeRes.status }, err);
    return c.json({ error: "Payment gateway error" }, 502);
  }

  const session = await stripeRes.json() as { id: string; url: string | null };
  return c.json({
    checkout_url: session.url,
    session_id: session.id,
  }, 200);
});

export default wrapper;
