// Stripe webhook route test (issue #74).
//
// Exercises the real POST /webhooks/stripe handler with a genuine HMAC
// signature (computed via the package's signPayload — the same scheme Stripe
// uses), against an in-memory fake D1. Covers: valid crediting, redelivery
// idempotency (stripe_event_id dedupe), bad signature → 400, unconfigured
// deployment → 501.

import { describe, it, expect, beforeEach } from "vitest";
import paymentsWebhookRoutes from "./payments";
import { signPayload } from "@duyet/oma-payments";

// ── Minimal in-memory D1 fake ────────────────────────────────────────────
// Interprets just the statements createD1PaymentsStore issues.

interface LedgerRow {
  stripe_event_id: string | null;
  delta: number;
  tenant_id: string;
  end_user_id: string;
}

class FakeD1 {
  processed = new Set<string>();
  ledger: LedgerRow[] = [];
  balances = new Map<string, number>();

  prepare(sql: string) {
    return new FakeStmt(this, sql);
  }
  async batch(stmts: FakeStmt[]) {
    for (const s of stmts) await s.run();
  }
}

class FakeStmt {
  private args: unknown[] = [];
  constructor(private db: FakeD1, private sql: string) {}
  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }
  async first<T = unknown>(): Promise<T | null> {
    if (this.sql.includes("FROM stripe_processed_events")) {
      return (this.db.processed.has(this.args[0] as string) ? ({ event_id: this.args[0] } as T) : null);
    }
    if (this.sql.includes("FROM end_user_balance")) {
      const key = `${this.args[0]}:${this.args[1]}`;
      const b = this.db.balances.get(key);
      return b == null ? null : ({ balance: b } as T);
    }
    return null;
  }
  async run() {
    if (this.sql.includes("INSERT INTO end_user_credit_ledger")) {
      this.db.ledger.push({
        tenant_id: this.args[1] as string,
        end_user_id: this.args[2] as string,
        delta: this.args[3] as number,
        stripe_event_id: this.args[7] as string | null,
      });
    } else if (this.sql.includes("INSERT INTO end_user_balance")) {
      const key = `${this.args[0]}:${this.args[1]}`;
      this.db.balances.set(key, (this.db.balances.get(key) ?? 0) + (this.args[2] as number));
    } else if (this.sql.includes("INSERT OR IGNORE INTO stripe_processed_events")) {
      this.db.processed.add(this.args[0] as string);
    }
  }
}

const SECRET = "whsec_test_route";

function envWith(db: FakeD1, secret: string | undefined = SECRET) {
  return { MAIN_DB: db as unknown as D1Database, STRIPE_WEBHOOK_SECRET: secret };
}

function checkoutBody(eventId: string, credits: number) {
  return JSON.stringify({
    id: eventId,
    type: "checkout.session.completed",
    data: { object: { metadata: { tenant_id: "t1", end_user_id: "u1", credits: String(credits) } } },
  });
}

async function postSigned(db: FakeD1, body: string, secret = SECRET, envSecret = SECRET) {
  const t = Math.floor(Date.now() / 1000);
  const header = await signPayload(body, secret, t);
  return paymentsWebhookRoutes.request(
    "/stripe",
    { method: "POST", headers: { "stripe-signature": header, "content-type": "application/json" }, body },
    envWith(db, envSecret),
  );
}

describe("POST /webhooks/stripe", () => {
  let db: FakeD1;
  beforeEach(() => {
    db = new FakeD1();
  });

  it("credits the wallet on a valid signed checkout.session.completed", async () => {
    const res = await postSigned(db, checkoutBody("evt_1", 100));
    expect(res.status).toBe(200);
    expect(db.ledger).toHaveLength(1);
    expect(db.ledger[0].delta).toBe(100);
    expect(db.balances.get("t1:u1")).toBe(100);
  });

  it("is idempotent on redelivery (same stripe_event_id)", async () => {
    await postSigned(db, checkoutBody("evt_dup", 50));
    const res2 = await postSigned(db, checkoutBody("evt_dup", 50));
    expect(res2.status).toBe(200);
    expect(db.ledger).toHaveLength(1);
    expect(db.balances.get("t1:u1")).toBe(50);
  });

  it("rejects a bad signature with 400", async () => {
    const body = checkoutBody("evt_2", 10);
    const t = Math.floor(Date.now() / 1000);
    const header = await signPayload(body, "whsec_wrong", t);
    const res = await paymentsWebhookRoutes.request(
      "/stripe",
      { method: "POST", headers: { "stripe-signature": header }, body },
      envWith(db),
    );
    expect(res.status).toBe(400);
    expect(db.ledger).toHaveLength(0);
  });

  it("returns 501 when the deployment has no webhook secret", async () => {
    const res = await paymentsWebhookRoutes.request(
      "/stripe",
      { method: "POST", body: "{}" },
      { MAIN_DB: db as unknown as D1Database },
    );
    expect(res.status).toBe(501);
  });
});
