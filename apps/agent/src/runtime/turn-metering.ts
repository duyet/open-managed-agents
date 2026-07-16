// Post-turn `per_1k_tokens` metering debit (issue #163).
//
// A publication priced `per_1k_tokens` is billed once per completed turn:
// `price_amount × ceil(tokens / 1000)` credits (AGENTS.md "Metering & paywall").
// The pre-turn gate (apps/main enforcePaywall) only admits a positive-balance
// wallet — the exact token cost is known only when the turn reaches idle. This
// runs in the agent Durable Object at `session.status_idle`, debiting the real
// cost against the SAME control-plane wallet the gate reads.
//
// Why here (not an agent→main HTTP hop): the agent worker already binds
// `MAIN_DB` (it writes the unified sessions table + usage_events there), and the
// wallet (`end_user_credit_ledger` / `end_user_balance` / `publication_pricing`)
// lives in that same D1. Debiting directly is the least-plumbing correct seam.
//
// The wallet SQL below mirrors `createD1PaymentsStore.applyEntry`
// (apps/main/src/routes/payments.ts). It is intentionally a separate copy — that
// store isn't importable from the agent worker, and the concurrent crediting /
// `stripe_event_id` dedupe work owns that function. Business logic (cost math,
// flooring, idempotency shape) is reused from `@duyet/oma-payments`.

import type { TurnDebitStore } from "@duyet/oma-payments";
import { computeTurnCost, debitTurnUsage } from "@duyet/oma-payments";

interface TurnPricingRow {
  mode: string;
  price_amount: number;
}

async function readPricing(
  db: D1Database,
  publicationId: string,
): Promise<TurnPricingRow | null> {
  const row = await db
    .prepare("SELECT mode, price_amount FROM publication_pricing WHERE publication_id = ?")
    .bind(publicationId)
    .first<TurnPricingRow>();
  return row ?? null;
}

/**
 * D1-backed idempotent per-turn debit store. Inserts the `turn_debits` guard
 * row FIRST (INSERT OR IGNORE, migration 0025); only a newly-inserted key
 * proceeds to the ledger movement. A duplicate turn signal (same `turnKey`) is
 * a no-op — the guard's PRIMARY KEY absorbs it, so a redelivered/crash-recovery
 * idle never double-charges. A crash between the guard insert and the ledger
 * batch under-charges (fail-open, honest) but never double-charges.
 */
function createD1TurnDebitStore(db: D1Database): TurnDebitStore {
  return {
    async recordTurnDebit(turnKey, entry) {
      const now = entry.created_at;
      const guard = await db
        .prepare(
          "INSERT OR IGNORE INTO turn_debits (turn_key, tenant_id, end_user_id, session_id, publication_id, credits, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          turnKey,
          entry.tenant_id,
          entry.end_user_id,
          entry.session_id,
          entry.publication_id,
          Math.abs(entry.delta),
          now,
        )
        .run();
      // Duplicate turn signal — the key was already recorded; don't debit again.
      if ((guard.meta?.changes ?? 0) === 0) return false;
      await db.batch([
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
            now,
          ),
        db
          .prepare(
            "INSERT INTO end_user_balance (tenant_id, end_user_id, balance, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(tenant_id, end_user_id) DO UPDATE SET balance = balance + excluded.balance, updated_at = excluded.updated_at",
          )
          .bind(entry.tenant_id, entry.end_user_id, entry.delta, now),
      ]);
      return true;
    },
  };
}

export interface MeterTurnParams {
  db: D1Database;
  tenantId: string;
  sessionId: string;
  publicationId: string;
  endUserId: string;
  /** Tokens consumed by THIS turn (input+output delta since the last metered
   *  turn). Zero/negative → no-op. */
  turnTokens: number;
  /** Session-wide cumulative token total after this turn. Forms the stable
   *  idempotency key (`${sessionId}:${cumulativeTotal}`) — identical across a
   *  redelivered or crash-recovery-re-emitted idle for the same turn. */
  cumulativeTotal: number;
}

/**
 * Debit a completed public turn priced `per_1k_tokens`, idempotently.
 *
 * No-op (`debited:false`) when the publication isn't priced `per_1k_tokens`,
 * the price is 0, or the turn produced no new tokens. Throws only on a D1
 * failure — the caller runs this fire-and-forget and logs errors (fail-open, so
 * a metering hiccup never fails or blocks the turn). Balance may go slightly
 * negative on the final turn (the gate ran pre-turn with a minimal reserve);
 * that overshoot is accepted, mirroring `PaymentsService.debit`.
 */
export async function meterTurnDebit(
  params: MeterTurnParams,
): Promise<{ debited: boolean; credits: number }> {
  if (params.turnTokens <= 0) return { debited: false, credits: 0 };
  const pricing = await readPricing(params.db, params.publicationId);
  if (!pricing || pricing.mode !== "per_1k_tokens") {
    return { debited: false, credits: 0 };
  }
  const credits = computeTurnCost("per_1k_tokens", pricing.price_amount, {
    messages: 0,
    tokens: params.turnTokens,
  });
  if (credits <= 0) return { debited: false, credits: 0 };
  const store = createD1TurnDebitStore(params.db);
  return debitTurnUsage(store, {
    tenantId: params.tenantId,
    endUserId: params.endUserId,
    credits,
    turnKey: `${params.sessionId}:${params.cumulativeTotal}`,
    reason: "per_1k_tokens",
    sessionId: params.sessionId,
    publicationId: params.publicationId,
  });
}
