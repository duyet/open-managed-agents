// Payments: Stripe webhook + consumer checkout + creator revenue (issue #74).
//
// The end-user credit wallet lives on the shared control-plane D1 (tenant +
// end_user scoped), separate from the operator infra-cost `usage_events`
// stream. Business logic — pricing math, idempotent crediting, gate checks —
// lives in `@duyet/oma-payments`; this file only wires the D1-backed store and
// the HTTP surface.
//
// Secrets: STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET are Worker secrets read
// from `c.env` only. They are never written to a session, ledger row, or any
// sandbox-visible path — the webhook verifies the signature and discards the
// secret; the wallet stores only the opaque `stripe_event_id`.

import { Hono } from "hono";
import { nanoid } from "nanoid";
import { z } from "zod";
import { getLogger } from "@duyet/oma-observability";
import {
  isPaymentsEnabled,
  PaymentsService,
  StripeClient,
  verifyWebhookSignature,
  computeTurnCost,
  isPricingMode,
  type LedgerEntry,
  type PaymentsStore,
  type PublicationPricing,
  type PricingMode,
} from "@duyet/oma-payments";

const log = getLogger("payments");

interface Env {
  Bindings: {
    MAIN_DB: D1Database;
    PAYMENTS_DISABLED?: string;
    STRIPE_SECRET_KEY?: string;
    STRIPE_WEBHOOK_SECRET?: string;
    PUBLIC_BASE_URL?: string;
  };
}

// ── D1-backed PaymentsStore ───────────────────────────────────────────────

export function createD1PaymentsStore(db: D1Database): PaymentsStore {
  return {
    async hasProcessedEvent(eventId) {
      const row = await db
        .prepare("SELECT event_id FROM stripe_processed_events WHERE event_id = ?")
        .bind(eventId)
        .first();
      return row != null;
    },

    async applyEntry(entry: LedgerEntry) {
      const now = new Date().toISOString();
      const statements = [
        db
          .prepare(
            "INSERT INTO end_user_credit_ledger (id, tenant_id, end_user_id, delta, reason, session_id, publication_id, stripe_event_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .bind(
            entry.id,
            entry.tenant_id,
            entry.end_user_id,
            entry.delta,
            entry.reason,
            entry.session_id,
            entry.publication_id,
            entry.stripe_event_id,
            entry.created_at,
          ),
        db
          .prepare(
            "INSERT INTO end_user_balance (tenant_id, end_user_id, balance, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(tenant_id, end_user_id) DO UPDATE SET balance = balance + excluded.balance, updated_at = excluded.updated_at",
          )
          .bind(entry.tenant_id, entry.end_user_id, entry.delta, now),
      ];
      // Mark the Stripe event processed in the SAME batch so a duplicate
      // webhook can never double-credit, even under a race.
      if (entry.stripe_event_id) {
        statements.push(
          db
            .prepare(
              "INSERT OR IGNORE INTO stripe_processed_events (event_id, event_type, processed_at) VALUES (?, ?, ?)",
            )
            .bind(entry.stripe_event_id, entry.reason, now),
        );
      }
      await db.batch(statements);
    },

    async getBalance(tenantId, endUserId) {
      const row = await db
        .prepare("SELECT balance FROM end_user_balance WHERE tenant_id = ? AND end_user_id = ?")
        .bind(tenantId, endUserId)
        .first<{ balance: number }>();
      return row?.balance ?? 0;
    },

    async hasActiveSubscription(tenantId, endUserId) {
      const row = await db
        .prepare(
          "SELECT id FROM end_user_subscription WHERE tenant_id = ? AND end_user_id = ? AND status = 'active' LIMIT 1",
        )
        .bind(tenantId, endUserId)
        .first();
      return row != null;
    },

    async totalSpendForPublication(tenantId, publicationId) {
      const row = await db
        .prepare(
          "SELECT COALESCE(SUM(-delta), 0) AS spend FROM end_user_credit_ledger WHERE tenant_id = ? AND publication_id = ? AND delta < 0",
        )
        .bind(tenantId, publicationId)
        .first<{ spend: number }>();
      return row?.spend ?? 0;
    },
  };
}

// ── Pricing lookup ─────────────────────────────────────────────────────────

export async function getPricingForPublication(
  db: D1Database,
  publicationId: string,
): Promise<PublicationPricing | null> {
  const row = await db
    .prepare("SELECT * FROM publication_pricing WHERE publication_id = ?")
    .bind(publicationId)
    .first<PublicationPricing>();
  return row ?? null;
}

// ── Pricing config write (issue #163) ────────────────────────────────────────
//
// Until now no route inserted a `publication_pricing` row, so the metered
// paywall was unconfigurable through the API. This is the tenant-authed write
// surface behind PUT /v1/publications/:id/pricing. Fields mirror the
// `publication_pricing` schema (migration 0021) exactly.

/** Body for PUT /v1/publications/:id/pricing. `price_amount` is credits per
 *  unit (per message, or per 1k tokens); ignored for free/subscription. */
export const publicationPricingInputSchema = z.object({
  mode: z.enum(["free", "per_message", "per_1k_tokens", "subscription"]),
  price_amount: z.number().int().min(0).default(0),
  currency: z.string().min(1).max(16).default("credits"),
  included_credits: z.number().int().min(0).default(0),
  stripe_price_id: z.string().min(1).nullable().default(null),
});

export type PublicationPricingInput = z.infer<typeof publicationPricingInputSchema>;

/** Upsert the (1:1) pricing row for a publication. Idempotent on
 *  `publication_id` (its unique index); preserves `id` + `created_at` on
 *  update. The caller MUST have already verified the publication belongs to
 *  `tenantId`. */
export async function upsertPublicationPricing(
  db: D1Database,
  tenantId: string,
  publicationId: string,
  input: PublicationPricingInput,
): Promise<PublicationPricing> {
  const now = new Date().toISOString();
  const existing = await getPricingForPublication(db, publicationId);
  const id = existing?.id ?? `pp_${nanoid()}`;
  const createdAt = existing?.created_at ?? now;
  await db
    .prepare(
      `INSERT INTO publication_pricing
         (id, tenant_id, publication_id, mode, price_amount, currency, included_credits, stripe_price_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(publication_id) DO UPDATE SET
         mode = excluded.mode,
         price_amount = excluded.price_amount,
         currency = excluded.currency,
         included_credits = excluded.included_credits,
         stripe_price_id = excluded.stripe_price_id,
         updated_at = excluded.updated_at`,
    )
    .bind(
      id,
      tenantId,
      publicationId,
      input.mode,
      input.price_amount,
      input.currency,
      input.included_credits,
      input.stripe_price_id,
      createdAt,
      now,
    )
    .run();
  const row = await getPricingForPublication(db, publicationId);
  return row!;
}

export interface PublicationPricingRoutesDeps {
  /** Resolve a publication the tenant owns, or null (not found / not owned).
   *  Guards a cross-tenant write: `publication_pricing` keys on the globally
   *  unique publication_id, so without this a tenant could edit another
   *  tenant's pricing. Receives the request context so the impl can build the
   *  per-tenant services container. */
  getOwnedPublication: (
    c: import("hono").Context,
    tenantId: string,
    publicationId: string,
  ) => Promise<{ id: string } | null>;
}

/**
 * GET/PUT /v1/publications/:id/pricing — tenant-authed pricing config (#163).
 *
 * Mounted (prefix-stripped to `/:id/pricing`) before the catch-all publications
 * routes; its two specific routes match first and every other publications path
 * falls through. Reads MAIN_DB from env, requires the auth-resolved tenant_id,
 * and verifies publication ownership before any read/write.
 */
export function buildPublicationPricingRoutes(deps: PublicationPricingRoutesDeps) {
  const app = new Hono<{ Bindings: Env["Bindings"]; Variables: { tenant_id: string } }>();

  app.get("/:id/pricing", async (c) => {
    if (!c.env.MAIN_DB) return c.json({ error: "Payments not configured" }, 503);
    const publicationId = c.req.param("id");
    const pub = await deps.getOwnedPublication(c, c.var.tenant_id, publicationId);
    if (!pub) return c.json({ error: "Publication not found" }, 404);
    const pricing = await getPricingForPublication(c.env.MAIN_DB, publicationId);
    return c.json(
      pricing ?? {
        publication_id: publicationId,
        mode: "free",
        price_amount: 0,
        currency: "credits",
        included_credits: 0,
        stripe_price_id: null,
      },
    );
  });

  app.put("/:id/pricing", async (c) => {
    if (!c.env.MAIN_DB) return c.json({ error: "Payments not configured" }, 503);
    const publicationId = c.req.param("id");
    const pub = await deps.getOwnedPublication(c, c.var.tenant_id, publicationId);
    if (!pub) return c.json({ error: "Publication not found" }, 404);
    const parsed = publicationPricingInputSchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success) {
      return c.json({ error: "Invalid pricing", details: parsed.error.flatten() }, 422);
    }
    const pricing = await upsertPublicationPricing(
      c.env.MAIN_DB,
      c.var.tenant_id,
      publicationId,
      parsed.data,
    );
    return c.json(pricing);
  });

  return app;
}

/**
 * Gate a public turn against the wallet. Returns null to allow, or a 402
 * Response (with a top-up URL) to block. `free` / no-pricing → always allow.
 * Payments disabled → always allow (self-host treats everything as free).
 *
 * For `per_message` the caller's per-turn cost is debited on allow.
 */
export async function enforcePaywall(opts: {
  env: Env["Bindings"];
  db: D1Database;
  tenantId: string;
  publicationId: string;
  endUserId: string;
  sessionId?: string | null;
}): Promise<Response | null> {
  if (!isPaymentsEnabled(opts.env)) return null;
  const pricing = await getPricingForPublication(opts.db, opts.publicationId);
  if (!pricing || pricing.mode === "free") return null;

  const store = createD1PaymentsStore(opts.db);
  const svc = new PaymentsService(store);
  const mode = pricing.mode as Exclude<PricingMode, "free">;
  const perMessageCost = computeTurnCost(pricing.mode, pricing.price_amount, {
    messages: 1,
    tokens: 0,
  });
  const gate = await svc.checkGate({
    tenantId: opts.tenantId,
    endUserId: opts.endUserId,
    mode,
    cost: perMessageCost,
    // per_1k_tokens can't be priced pre-turn (tokens unknown) — require at
    // least one minimal turn's worth (price_amount credits). The real cost is
    // debited post-turn in the agent DO (see debitTurnUsage / metering hook).
    priceAmount: pricing.price_amount,
  });
  if (!gate.allowed) {
    const base = opts.env.PUBLIC_BASE_URL ?? "";
    return Response.json(
      {
        error: "Payment required",
        code: "insufficient_credits",
        balance: gate.balance,
        shortfall: gate.shortfall,
        top_up_url: `${base}/p/pay?publication=${opts.publicationId}`,
      },
      { status: 402 },
    );
  }
  // per_message: debit the turn up front. per_1k_tokens is metered post-turn
  // by the session-idle hook in the agent DO (maybeMeterTurn → debitTurnUsage,
  // issue #163); subscription is access-gated, not metered.
  if (pricing.mode === "per_message" && perMessageCost > 0) {
    await svc.debit({
      tenantId: opts.tenantId,
      endUserId: opts.endUserId,
      credits: perMessageCost,
      reason: "per_message",
      sessionId: opts.sessionId ?? null,
      publicationId: opts.publicationId,
    });
  }
  return null;
}

// per_1k_tokens post-turn debit (issue #163) is wired at the session-idle seam
// in apps/agent/src/runtime/session-do.ts (`maybeMeterTurn`), which debits the
// real token cost against this same MAIN_DB wallet via `debitTurnUsage`. The
// agent DO binds MAIN_DB directly, so no agent→main HTTP hop is needed. The
// gate above only admits a positive-balance wallet; the exact cost is charged
// once the turn's token total is known.

// ── HTTP routes ─────────────────────────────────────────────────────────────

const app = new Hono<Env>();

// POST /webhooks/stripe — signature-verified, idempotent crediting.
// Mounted OUTSIDE tenant auth (see auth.ts bypass); trust comes from the
// Stripe signature, not an api-key.
app.post("/stripe", async (c) => {
  const secret = c.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    // Payments not configured on this deployment — nothing to verify against.
    return c.json({ error: "Webhooks not configured" }, 501);
  }
  const raw = await c.req.text();
  const sig = c.req.header("stripe-signature");

  let event;
  try {
    event = await verifyWebhookSignature(raw, sig, secret);
  } catch (err) {
    log.warn({ err: String(err) }, "stripe signature verification failed");
    return c.json({ error: "Invalid signature" }, 400);
  }

  const store = createD1PaymentsStore(c.env.MAIN_DB);
  const svc = new PaymentsService(store);
  try {
    const entry = await svc.creditFromEvent(event);
    if (entry) {
      log.info(
        { event_id: event.id, type: event.type, credits: entry.delta, tenant: entry.tenant_id },
        "wallet credited from stripe webhook",
      );
    }
  } catch (err) {
    log.error({ err: String(err), event_id: event.id }, "failed to apply stripe event");
    return c.json({ error: "Processing failed" }, 500);
  }
  return c.json({ received: true }, 200);
});

export default app;
export { app as paymentsWebhookRoutes };

// ── Consumer checkout + creator revenue ──────────────────────────────────────

/** Build the public consumer checkout + creator revenue routes. Kept as a
 *  factory so the gate + store wiring is shared. */
export function buildConsumerPaymentsRoutes() {
  const routes = new Hono<Env & { Variables: { consumer_id?: string; tenant_id?: string } }>();

  // POST /v1/public/payments/checkout — Stripe Checkout for a wallet top-up.
  routes.post("/payments/checkout", async (c) => {
    if (!isPaymentsEnabled(c.env)) return c.json({ error: "Payments disabled" }, 501);
    const body = (await c.req.json().catch(() => ({}))) as {
      publication_id?: string;
      tenant_id?: string;
      end_user_id?: string;
      quantity?: number;
    };
    if (!body.publication_id || !body.tenant_id || !body.end_user_id) {
      return c.json({ error: "publication_id, tenant_id, end_user_id required" }, 400);
    }
    const pricing = await getPricingForPublication(c.env.MAIN_DB, body.publication_id);
    if (!pricing?.stripe_price_id) {
      return c.json({ error: "Publication has no purchasable price" }, 400);
    }
    const client = new StripeClient(c.env.STRIPE_SECRET_KEY!);
    const base = c.env.PUBLIC_BASE_URL ?? c.req.header("origin") ?? "";
    const session = await client.createCheckoutSession({
      mode: pricing.mode === "subscription" ? "subscription" : "payment",
      priceId: pricing.stripe_price_id,
      quantity: body.quantity ?? 1,
      successUrl: `${base}/p/pay/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${base}/p/pay/cancel`,
      clientReferenceId: body.end_user_id,
      metadata: {
        tenant_id: body.tenant_id,
        end_user_id: body.end_user_id,
        publication_id: body.publication_id,
        credits: String(pricing.included_credits * (body.quantity ?? 1)),
      },
    });
    return c.json({ checkout_url: session.url, session_id: session.id }, 200);
  });

  return routes;
}
