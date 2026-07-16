import { describe, expect, it } from "vitest";
import {
  computeTurnCost,
  debitTurnUsage,
  isMetered,
  isPaymentsEnabled,
  isPricingMode,
  PaymentsService,
  signPayload,
  StripeSignatureError,
  verifyWebhookSignature,
  type LedgerEntry,
  type PaymentsStore,
  type StripeEvent,
  type TurnDebitStore,
} from "./index";

describe("pricing", () => {
  it("free and subscription never cost credits", () => {
    expect(computeTurnCost("free", 10, { messages: 5, tokens: 9999 })).toBe(0);
    expect(computeTurnCost("subscription", 10, { messages: 5, tokens: 9999 })).toBe(0);
  });

  it("per_message charges price per message", () => {
    expect(computeTurnCost("per_message", 2, { messages: 3, tokens: 0 })).toBe(6);
    expect(computeTurnCost("per_message", 1, { messages: 0, tokens: 0 })).toBe(0);
  });

  it("per_1k_tokens rounds up to the next 1k block", () => {
    expect(computeTurnCost("per_1k_tokens", 5, { messages: 1, tokens: 1 })).toBe(5);
    expect(computeTurnCost("per_1k_tokens", 5, { messages: 1, tokens: 1000 })).toBe(5);
    expect(computeTurnCost("per_1k_tokens", 5, { messages: 1, tokens: 1001 })).toBe(10);
    expect(computeTurnCost("per_1k_tokens", 5, { messages: 1, tokens: 0 })).toBe(0);
  });

  it("classifies modes", () => {
    expect(isPricingMode("per_message")).toBe(true);
    expect(isPricingMode("nope")).toBe(false);
    expect(isMetered("per_message")).toBe(true);
    expect(isMetered("subscription")).toBe(false);
  });
});

describe("isPaymentsEnabled", () => {
  it("false when disabled or no secret", () => {
    expect(isPaymentsEnabled({})).toBe(false);
    expect(isPaymentsEnabled({ STRIPE_SECRET_KEY: "sk_test" })).toBe(true);
    expect(isPaymentsEnabled({ STRIPE_SECRET_KEY: "sk_test", PAYMENTS_DISABLED: "1" })).toBe(false);
    expect(isPaymentsEnabled({ STRIPE_SECRET_KEY: "sk_test", PAYMENTS_DISABLED: "0" })).toBe(true);
  });
});

describe("verifyWebhookSignature", () => {
  const secret = "whsec_test_123";

  it("accepts a genuine signature and parses the event", async () => {
    const body = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });
    const t = Math.floor(Date.now() / 1000);
    const header = await signPayload(body, secret, t);
    const event = await verifyWebhookSignature(body, header, secret, { nowSec: t });
    expect(event.id).toBe("evt_1");
  });

  it("rejects a tampered body", async () => {
    const body = JSON.stringify({ id: "evt_1", type: "x" });
    const t = Math.floor(Date.now() / 1000);
    const header = await signPayload(body, secret, t);
    await expect(
      verifyWebhookSignature(body + "tamper", header, secret, { nowSec: t }),
    ).rejects.toBeInstanceOf(StripeSignatureError);
  });

  it("rejects the wrong secret", async () => {
    const body = "{}";
    const t = Math.floor(Date.now() / 1000);
    const header = await signPayload(body, secret, t);
    await expect(
      verifyWebhookSignature(body, header, "whsec_other", { nowSec: t }),
    ).rejects.toBeInstanceOf(StripeSignatureError);
  });

  it("rejects a stale timestamp (replay)", async () => {
    const body = "{}";
    const t = 1_000_000;
    const header = await signPayload(body, secret, t);
    await expect(
      verifyWebhookSignature(body, header, secret, { nowSec: t + 10_000, toleranceSec: 300 }),
    ).rejects.toBeInstanceOf(StripeSignatureError);
  });

  it("rejects a missing header", async () => {
    await expect(verifyWebhookSignature("{}", null, secret)).rejects.toBeInstanceOf(
      StripeSignatureError,
    );
  });
});

/** In-memory store for service tests. */
class FakeStore implements PaymentsStore {
  entries: LedgerEntry[] = [];
  processed = new Set<string>();
  subscriptions = new Set<string>();

  async hasProcessedEvent(id: string) {
    return this.processed.has(id);
  }
  async applyEntry(entry: LedgerEntry) {
    this.entries.push(entry);
    if (entry.stripe_event_id) this.processed.add(entry.stripe_event_id);
  }
  async getBalance(tenantId: string, endUserId: string) {
    return this.entries
      .filter((e) => e.tenant_id === tenantId && e.end_user_id === endUserId)
      .reduce((s, e) => s + e.delta, 0);
  }
  async hasActiveSubscription(tenantId: string, endUserId: string) {
    return this.subscriptions.has(`${tenantId}:${endUserId}`);
  }
  async totalSpendForPublication() {
    return this.entries.filter((e) => e.delta < 0).reduce((s, e) => s - e.delta, 0);
  }
}

function checkoutEvent(id: string, credits: number): StripeEvent {
  return {
    id,
    type: "checkout.session.completed",
    data: { object: { metadata: { tenant_id: "t1", end_user_id: "u1", credits: String(credits) } } },
  };
}

describe("PaymentsService.creditFromEvent", () => {
  it("credits the wallet on checkout.session.completed", async () => {
    const store = new FakeStore();
    const svc = new PaymentsService(store);
    await svc.creditFromEvent(checkoutEvent("evt_a", 100));
    expect(await svc.getBalance("t1", "u1")).toBe(100);
  });

  it("is idempotent on redelivery (stripe_event_id dedupe)", async () => {
    const store = new FakeStore();
    const svc = new PaymentsService(store);
    await svc.creditFromEvent(checkoutEvent("evt_a", 100));
    await svc.creditFromEvent(checkoutEvent("evt_a", 100));
    expect(await svc.getBalance("t1", "u1")).toBe(100);
    expect(store.entries).toHaveLength(1);
  });

  it("ignores unhandled event types", async () => {
    const store = new FakeStore();
    const svc = new PaymentsService(store);
    const res = await svc.creditFromEvent({
      id: "evt_x",
      type: "payment_intent.created",
      data: { object: {} },
    });
    expect(res).toBeNull();
  });
});

describe("PaymentsService.checkGate + debit", () => {
  it("blocks at zero balance and reports the shortfall", async () => {
    const svc = new PaymentsService(new FakeStore());
    const gate = await svc.checkGate({
      tenantId: "t1",
      endUserId: "u1",
      mode: "per_message",
      cost: 3,
    });
    expect(gate.allowed).toBe(false);
    expect(gate.shortfall).toBe(3);
  });

  it("allows when the wallet covers the cost, then debits", async () => {
    const store = new FakeStore();
    const svc = new PaymentsService(store);
    await svc.creditFromEvent(checkoutEvent("evt_a", 10));
    const gate = await svc.checkGate({ tenantId: "t1", endUserId: "u1", mode: "per_message", cost: 4 });
    expect(gate.allowed).toBe(true);
    await svc.debit({ tenantId: "t1", endUserId: "u1", credits: 4, reason: "per_message" });
    expect(await svc.getBalance("t1", "u1")).toBe(6);
  });

  it("subscription gate depends on an active subscription", async () => {
    const store = new FakeStore();
    const svc = new PaymentsService(store);
    let gate = await svc.checkGate({ tenantId: "t1", endUserId: "u1", mode: "subscription", cost: 0 });
    expect(gate.allowed).toBe(false);
    store.subscriptions.add("t1:u1");
    gate = await svc.checkGate({ tenantId: "t1", endUserId: "u1", mode: "subscription", cost: 0 });
    expect(gate.allowed).toBe(true);
  });

  it("per_1k_tokens gate requires a max(1, price_amount) reserve (#163)", async () => {
    const store = new FakeStore();
    const svc = new PaymentsService(store);
    // price_amount=5 → require 5, not the old flat 1.
    await svc.creditFromEvent(checkoutEvent("evt_a", 4));
    let gate = await svc.checkGate({
      tenantId: "t1",
      endUserId: "u1",
      mode: "per_1k_tokens",
      cost: 0, // per_1k can't be priced pre-turn
      priceAmount: 5,
    });
    expect(gate.allowed).toBe(false);
    expect(gate.shortfall).toBe(1); // 5 required − 4 balance

    await svc.creditFromEvent(checkoutEvent("evt_b", 1)); // balance → 5
    gate = await svc.checkGate({
      tenantId: "t1",
      endUserId: "u1",
      mode: "per_1k_tokens",
      cost: 0,
      priceAmount: 5,
    });
    expect(gate.allowed).toBe(true);
  });

  it("per_1k_tokens gate floors the reserve at 1 when price_amount is 0", async () => {
    const svc = new PaymentsService(new FakeStore());
    const gate = await svc.checkGate({
      tenantId: "t1",
      endUserId: "u1",
      mode: "per_1k_tokens",
      cost: 0,
      priceAmount: 0,
    });
    expect(gate.allowed).toBe(false);
    expect(gate.shortfall).toBe(1);
  });
});

/** In-memory idempotent turn-debit store (#163). Mirrors the D1 guard: a
 *  turnKey applies exactly once. */
class FakeTurnStore implements TurnDebitStore {
  keys = new Set<string>();
  entries: LedgerEntry[] = [];
  async recordTurnDebit(turnKey: string, entry: LedgerEntry) {
    if (this.keys.has(turnKey)) return false;
    this.keys.add(turnKey);
    this.entries.push(entry);
    return true;
  }
  balance() {
    return this.entries.reduce((s, e) => s + e.delta, 0);
  }
}

describe("debitTurnUsage (post-turn per_1k_tokens metering, #163)", () => {
  it("debits the computed turn cost as a negative delta", async () => {
    const store = new FakeTurnStore();
    // 2500 tokens @ 5 credits / 1k → ceil(2500/1000) * 5 = 15.
    const credits = computeTurnCost("per_1k_tokens", 5, { messages: 0, tokens: 2500 });
    expect(credits).toBe(15);
    const res = await debitTurnUsage(store, {
      tenantId: "t1",
      endUserId: "u1",
      credits,
      turnKey: "sess_1:2500",
      publicationId: "pub_1",
      sessionId: "sess_1",
    });
    expect(res).toEqual({ debited: true, credits: 15 });
    expect(store.balance()).toBe(-15);
    expect(store.entries[0]).toMatchObject({ delta: -15, reason: "per_1k_tokens" });
  });

  it("is idempotent — the same turn signal twice debits once", async () => {
    const store = new FakeTurnStore();
    const args = {
      tenantId: "t1",
      endUserId: "u1",
      credits: 15,
      turnKey: "sess_1:2500",
      sessionId: "sess_1",
    };
    const first = await debitTurnUsage(store, args);
    const second = await debitTurnUsage(store, args); // redelivered idle
    expect(first.debited).toBe(true);
    expect(second.debited).toBe(false); // guard absorbed the duplicate
    expect(second.credits).toBe(15); // still reports the cost for observability
    expect(store.entries).toHaveLength(1);
    expect(store.balance()).toBe(-15);
  });

  it("no-ops for a zero/negative cost without touching the store", async () => {
    const store = new FakeTurnStore();
    const res = await debitTurnUsage(store, {
      tenantId: "t1",
      endUserId: "u1",
      credits: 0,
      turnKey: "sess_1:0",
    });
    expect(res).toEqual({ debited: false, credits: 0 });
    expect(store.entries).toHaveLength(0);
  });

  it("distinct turns (distinct keys) each debit once", async () => {
    const store = new FakeTurnStore();
    await debitTurnUsage(store, { tenantId: "t1", endUserId: "u1", credits: 5, turnKey: "sess_1:1000" });
    await debitTurnUsage(store, { tenantId: "t1", endUserId: "u1", credits: 5, turnKey: "sess_1:2000" });
    expect(store.entries).toHaveLength(2);
    expect(store.balance()).toBe(-10);
  });
});
