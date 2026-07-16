// End-user credit wallet + idempotent Stripe crediting (issue #74).
//
// This is the creator-facing consumer-billing stream, kept SEPARATE from the
// operator infra-cost `usage_events` stream. The wallet is an append-only
// ledger keyed by (tenant_id, end_user_id); balance is the sum of deltas, with
// a cached `end_user_balance` row for hot-path reads. All persistence lives
// behind the `PaymentsStore` port so the same logic runs on D1 (CF) and
// Postgres/SQLite (self-host) — and can be stubbed when payments are disabled.

import type { StripeEvent } from "./stripe";

/** One append-only wallet movement. `delta > 0` top-up, `delta < 0` usage. */
export interface LedgerEntry {
  id: string;
  tenant_id: string;
  end_user_id: string;
  delta: number;
  reason: string;
  session_id: string | null;
  /** Publication the movement is attributed to (powers the revenue view). */
  publication_id: string | null;
  /** Stripe event id that produced this entry (null for usage debits). */
  stripe_event_id: string | null;
  created_at: string;
}

export interface PaymentsStore {
  /** Idempotency guard: true if this Stripe event id was already applied. */
  hasProcessedEvent(eventId: string): Promise<boolean>;
  /** Append a ledger entry AND advance the cached balance atomically. When
   *  `entry.stripe_event_id` is set the adapter must also mark it processed,
   *  so a duplicate webhook is a no-op even under a race. */
  applyEntry(entry: LedgerEntry): Promise<void>;
  /** Cached wallet balance (sum of deltas). 0 when no wallet exists yet. */
  getBalance(tenantId: string, endUserId: string): Promise<number>;
  /** Whether the end-user holds an active subscription for this tenant. */
  hasActiveSubscription(tenantId: string, endUserId: string): Promise<boolean>;
  /** Total consumer spend (sum of negative deltas, as a positive number)
   *  for a publication — powers the creator revenue view. */
  totalSpendForPublication(tenantId: string, publicationId: string): Promise<number>;
}

let counter = 0;
function ledgerId(): string {
  counter = (counter + 1) % 1_000_000;
  return `ecl_${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Result of a wallet gate check at the public chat surface. */
export interface GateResult {
  allowed: boolean;
  /** Credits the caller must top up to proceed (0 when allowed). */
  shortfall: number;
  balance: number;
}

export class PaymentsService {
  constructor(private readonly store: PaymentsStore) {}

  getBalance(tenantId: string, endUserId: string): Promise<number> {
    return this.store.getBalance(tenantId, endUserId);
  }

  /**
   * Gate a paid turn: `subscription` requires an active subscription; metered
   * modes require `balance >= cost`. `free` is handled by the caller (no
   * pricing row → never reaches here).
   */
  async checkGate(opts: {
    tenantId: string;
    endUserId: string;
    mode: "per_message" | "per_1k_tokens" | "subscription";
    cost: number;
  }): Promise<GateResult> {
    if (opts.mode === "subscription") {
      const active = await this.store.hasActiveSubscription(opts.tenantId, opts.endUserId);
      return { allowed: active, shortfall: active ? 0 : 1, balance: 0 };
    }
    const balance = await this.store.getBalance(opts.tenantId, opts.endUserId);
    // per_1k_tokens can't be priced pre-turn — require a positive balance and
    // debit the real cost post-turn. per_message debits `cost` up front.
    const required = opts.mode === "per_message" ? Math.max(1, opts.cost) : 1;
    const allowed = balance >= required;
    return { allowed, shortfall: allowed ? 0 : required - balance, balance };
  }

  /** Debit the wallet for observed usage (post-turn metering hook). No-op for
   *  a zero cost. Does not guard against going negative — the gate already
   *  ran; a small overshoot on the final turn is acceptable. */
  async debit(opts: {
    tenantId: string;
    endUserId: string;
    credits: number;
    reason: string;
    sessionId?: string | null;
    publicationId?: string | null;
  }): Promise<void> {
    if (opts.credits <= 0) return;
    await this.store.applyEntry({
      id: ledgerId(),
      tenant_id: opts.tenantId,
      end_user_id: opts.endUserId,
      delta: -Math.floor(opts.credits),
      reason: opts.reason,
      session_id: opts.sessionId ?? null,
      publication_id: opts.publicationId ?? null,
      stripe_event_id: null,
      created_at: new Date().toISOString(),
    });
  }

  /**
   * Apply a verified Stripe event to the wallet, exactly once.
   *
   * Credits are granted on `checkout.session.completed` and `invoice.paid`.
   * The `stripe_event_id` dedupe (checked here AND enforced in `applyEntry`)
   * makes redelivery — which Stripe does routinely — a no-op.
   *
   * Returns the credited entry, or null when ignored (already processed,
   * unhandled type, or missing attribution metadata).
   */
  async creditFromEvent(event: StripeEvent): Promise<LedgerEntry | null> {
    const HANDLED = new Set(["checkout.session.completed", "invoice.paid"]);
    if (!HANDLED.has(event.type)) return null;
    if (await this.store.hasProcessedEvent(event.id)) return null;

    const obj = event.data.object ?? {};
    const metadata = (obj.metadata as Record<string, string> | undefined) ?? {};
    const tenantId = metadata.tenant_id;
    const endUserId = metadata.end_user_id;
    const credits = Number(metadata.credits ?? 0);
    if (!tenantId || !endUserId || !Number.isFinite(credits) || credits <= 0) {
      // Nothing to attribute — record the event as processed via a zero entry
      // so we never reprocess it, but only if we still have a tenant/user.
      return null;
    }

    const entry: LedgerEntry = {
      id: ledgerId(),
      tenant_id: tenantId,
      end_user_id: endUserId,
      delta: Math.floor(credits),
      reason: event.type === "invoice.paid" ? "subscription_invoice" : "topup",
      session_id: null,
      publication_id: metadata.publication_id ?? null,
      stripe_event_id: event.id,
      created_at: new Date().toISOString(),
    };
    await this.store.applyEntry(entry);
    return entry;
  }
}
