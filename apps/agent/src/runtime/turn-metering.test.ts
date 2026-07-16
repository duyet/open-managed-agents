// Post-turn per_1k_tokens metering debit test (issue #163).
//
// Exercises meterTurnDebit against an in-memory fake D1 that interprets the
// statements createD1TurnDebitStore issues — the REAL guard-first idempotency
// path (INSERT OR IGNORE into turn_debits + meta.changes), which the
// @duyet/oma-payments package test (fake Set store) doesn't cover.

import { describe, it, expect, beforeEach } from "vitest";
import { meterTurnDebit } from "./turn-metering";

class FakeD1 {
  pricing = new Map<string, { mode: string; price_amount: number }>();
  turnKeys = new Set<string>();
  ledger: Array<{ delta: number; reason: string; session_id: string }> = [];
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
    if (this.sql.includes("FROM publication_pricing")) {
      return (this.db.pricing.get(this.args[0] as string) as T | undefined) ?? null;
    }
    return null;
  }
  async run() {
    if (this.sql.includes("INSERT OR IGNORE INTO turn_debits")) {
      const turnKey = this.args[0] as string;
      if (this.db.turnKeys.has(turnKey)) return { meta: { changes: 0 } };
      this.db.turnKeys.add(turnKey);
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("INSERT INTO end_user_credit_ledger")) {
      this.db.ledger.push({
        delta: this.args[3] as number,
        reason: this.args[4] as string,
        session_id: this.args[5] as string,
      });
    } else if (this.sql.includes("INSERT INTO end_user_balance")) {
      const key = `${this.args[0]}:${this.args[1]}`;
      this.db.balances.set(key, (this.db.balances.get(key) ?? 0) + (this.args[2] as number));
    }
    return { meta: { changes: 1 } };
  }
}

function params(db: FakeD1, over: Partial<Parameters<typeof meterTurnDebit>[0]> = {}) {
  return {
    db: db as unknown as D1Database,
    tenantId: "t1",
    sessionId: "sess_1",
    publicationId: "pub_1",
    endUserId: "eu_1",
    turnTokens: 2500,
    cumulativeTotal: 2500,
    ...over,
  };
}

describe("meterTurnDebit", () => {
  let db: FakeD1;
  beforeEach(() => {
    db = new FakeD1();
    db.pricing.set("pub_1", { mode: "per_1k_tokens", price_amount: 5 });
  });

  it("debits price_amount x ceil(tokens/1000) for a per_1k_tokens turn", async () => {
    const res = await meterTurnDebit(params(db)); // 2500 tokens @ 5/1k → 15
    expect(res).toEqual({ debited: true, credits: 15 });
    expect(db.ledger).toHaveLength(1);
    expect(db.ledger[0]).toMatchObject({ delta: -15, reason: "per_1k_tokens" });
    expect(db.balances.get("t1:eu_1")).toBe(-15);
  });

  it("is idempotent — the same turn key debits once (real D1 guard)", async () => {
    const first = await meterTurnDebit(params(db));
    const second = await meterTurnDebit(params(db)); // redelivered idle, same key
    expect(first.debited).toBe(true);
    expect(second.debited).toBe(false);
    expect(db.ledger).toHaveLength(1);
    expect(db.balances.get("t1:eu_1")).toBe(-15);
  });

  it("distinct turns (distinct cumulativeTotal) each debit", async () => {
    await meterTurnDebit(params(db, { turnTokens: 1000, cumulativeTotal: 1000 }));
    await meterTurnDebit(params(db, { turnTokens: 1000, cumulativeTotal: 2000 }));
    expect(db.ledger).toHaveLength(2);
    expect(db.balances.get("t1:eu_1")).toBe(-10); // 5 + 5
  });

  it("no-ops when the publication isn't priced per_1k_tokens", async () => {
    db.pricing.set("pub_1", { mode: "per_message", price_amount: 5 });
    const res = await meterTurnDebit(params(db));
    expect(res).toEqual({ debited: false, credits: 0 });
    expect(db.ledger).toHaveLength(0);
  });

  it("no-ops when there's no pricing row", async () => {
    db.pricing.clear();
    const res = await meterTurnDebit(params(db));
    expect(res.debited).toBe(false);
    expect(db.ledger).toHaveLength(0);
  });

  it("no-ops for a zero-token turn without reading pricing", async () => {
    const res = await meterTurnDebit(params(db, { turnTokens: 0 }));
    expect(res).toEqual({ debited: false, credits: 0 });
    expect(db.ledger).toHaveLength(0);
    expect(db.turnKeys.size).toBe(0);
  });
});
