import { Hono } from "hono";
import { z } from "zod";
import { getLogger } from "@duyet/oma-observability";
import { isPaymentsEnabled, PaymentsService, StripeClient } from "@duyet/oma-payments";
import { resolveConsumerSession } from "./consumer-auth";
import { createD1PaymentsStore, getPricingForPublication } from "./payments";

const log = getLogger("consumer-metering");

interface Env {
  Bindings: {
    MAIN_DB: D1Database;
    STRIPE_SECRET_KEY?: string;
    PAYMENTS_DISABLED?: string;
    PUBLIC_BASE_URL?: string;
  };
  Variables: {
    consumer_id: string;
  };
}

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

/**
 * Resolve the publication a consumer is buying/checking credits for. The
 * shared control-plane D1 makes a cross-tenant lookup by `agent_id` safe
 * (same assumption `PublicationRepo.getBySlug` already relies on for slugs) —
 * `requireConsumer()` only proves who the consumer is, not which tenant owns
 * the agent, so the tenant has to come from here.
 */
async function resolvePublicationForAgent(
  db: D1Database,
  agentId: string,
): Promise<{ id: string; tenant_id: string } | null> {
  const row = await db
    .prepare(
      "SELECT id, tenant_id FROM agent_publication WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .bind(agentId)
    .first<{ id: string; tenant_id: string }>();
  return row ?? null;
}

/** Stable wallet identity for a consumer bearer session. MUST match
 *  resolveEndUserId in apps/main/src/index.ts so a Stripe webhook credits the
 *  exact wallet enforcePaywall reads (issue #159). */
function endUserIdForConsumer(consumerId: string): string {
  return `eu:${consumerId}`;
}

// GET /credits?agent_id=<agent_id> — read the real wallet balance
// (end_user_balance, via PaymentsService) for the publication behind
// `agent_id`. Replaces the old consumer_credits-backed read (issue #159).
wrapper.get("/credits", requireConsumer(), async (c) => {
  const consumerId = c.var.consumer_id;
  const agentId = c.req.query("agent_id");
  if (!agentId) {
    return c.json({ error: "agent_id is required" }, 400);
  }

  const db = c.env.MAIN_DB;
  const publication = await resolvePublicationForAgent(db, agentId);
  if (!publication) {
    return c.json({ error: "Unknown agent" }, 404);
  }

  const svc = new PaymentsService(createD1PaymentsStore(db));
  const balance = await svc.getBalance(publication.tenant_id, endUserIdForConsumer(consumerId));

  return c.json({ agent_id: agentId, tenant_id: publication.tenant_id, balance }, 200);
});

// POST /buy-credits — Stripe Checkout for a wallet top-up. Rewritten to
// stamp the SAME metadata keys the webhook (creditFromEvent) reads and to
// credit the SAME wallet enforcePaywall gates against — the previous
// implementation stamped metadata[consumer_id]/[agent_id] against a global
// STRIPE_PRICE_ID and wrote to the orphaned consumer_credits table, so the
// webhook never matched it and no credits were ever granted (issue #159).
wrapper.post("/buy-credits", requireConsumer(), async (c) => {
  const consumerId = c.var.consumer_id;
  const body = await c.req.json().catch(() => ({}));
  const { agent_id, credits } = z
    .object({ agent_id: z.string(), credits: z.number().int().positive() })
    .parse(body);

  if (!isPaymentsEnabled(c.env)) {
    return c.json({ error: "Payments disabled" }, 501);
  }

  const db = c.env.MAIN_DB;
  const publication = await resolvePublicationForAgent(db, agent_id);
  if (!publication) {
    return c.json({ error: "Unknown agent" }, 404);
  }

  const pricing = await getPricingForPublication(db, publication.id);
  if (!pricing?.stripe_price_id) {
    return c.json({ error: "Publication has no purchasable price" }, 400);
  }

  const endUserId = endUserIdForConsumer(consumerId);
  const base = c.env.PUBLIC_BASE_URL ?? c.req.header("origin") ?? "http://localhost:8787";
  const client = new StripeClient(c.env.STRIPE_SECRET_KEY!);

  let session;
  try {
    session = await client.createCheckoutSession({
      mode: "payment",
      priceId: pricing.stripe_price_id,
      quantity: credits,
      successUrl: `${base}/credits/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${base}/credits/cancel`,
      clientReferenceId: endUserId,
      metadata: {
        tenant_id: publication.tenant_id,
        end_user_id: endUserId,
        publication_id: publication.id,
        credits: String(credits),
      },
    });
  } catch (err) {
    log.error({ consumer_id: consumerId, err: String(err) }, "stripe checkout create failed");
    return c.json({ error: "Payment gateway error" }, 502);
  }

  return c.json({
    checkout_url: session.url,
    session_id: session.id,
  }, 200);
});

export default wrapper;
