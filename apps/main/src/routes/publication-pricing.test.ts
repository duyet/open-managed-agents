// Publication pricing config route test (issue #163).
//
// Exercises the real GET/PUT /:id/pricing handlers from
// buildPublicationPricingRoutes against an in-memory fake D1 that interprets the
// publication_pricing statements upsertPublicationPricing / getPricingForPublication
// issue. Covers: upsert round-trip, zod validation (422), ownership (404),
// GET default when unset, and idempotent id/created_at on re-PUT.

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { buildPublicationPricingRoutes } from "./payments";
import type { PublicationPricingRoutesDeps } from "./payments";

interface PricingRow {
  id: string;
  tenant_id: string;
  publication_id: string;
  mode: string;
  price_amount: number;
  currency: string;
  included_credits: number;
  stripe_price_id: string | null;
  created_at: string;
  updated_at: string;
}

// Minimal in-memory D1 fake — interprets just the publication_pricing SQL.
class FakeD1 {
  rows = new Map<string, PricingRow>();
  prepare(sql: string) {
    return new FakeStmt(this, sql);
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
      return (this.db.rows.get(this.args[0] as string) as T | undefined) ?? null;
    }
    return null;
  }
  async run() {
    if (this.sql.includes("INSERT INTO publication_pricing")) {
      const [
        id,
        tenant_id,
        publication_id,
        mode,
        price_amount,
        currency,
        included_credits,
        stripe_price_id,
        created_at,
        updated_at,
      ] = this.args as [
        string,
        string,
        string,
        string,
        number,
        string,
        number,
        string | null,
        string,
        string,
      ];
      this.db.rows.set(publication_id, {
        id,
        tenant_id,
        publication_id,
        mode,
        price_amount,
        currency,
        included_credits,
        stripe_price_id,
        created_at,
        updated_at,
      });
    }
    return { success: true, meta: { changes: 1 } };
  }
}

/** Build a request-runner for the pricing routes with the given ownership +
 *  tenant, backed by `db`. */
function makeApp(
  db: FakeD1,
  opts: { owned?: Set<string>; tenant?: string } = {},
) {
  const owned = opts.owned ?? new Set(["pub-1"]);
  const deps: PublicationPricingRoutesDeps = {
    getOwnedPublication: async (_c, _tenantId, id) =>
      owned.has(id) ? { id } : null,
  };
  const parent = new Hono<{
    Bindings: { MAIN_DB: unknown };
    Variables: { tenant_id: string };
  }>();
  parent.use("*", async (c, next) => {
    c.set("tenant_id", opts.tenant ?? "tenant-a");
    await next();
  });
  parent.route("/", buildPublicationPricingRoutes(deps) as never);
  return (path: string, init?: RequestInit) =>
    parent.request(path, init, { MAIN_DB: db as unknown });
}

describe("PUT/GET /v1/publications/:id/pricing", () => {
  let db: FakeD1;
  beforeEach(() => {
    db = new FakeD1();
  });

  it("upserts pricing and echoes the stored row", async () => {
    const req = makeApp(db);
    const res = await req("/pub-1/pricing", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "per_1k_tokens", price_amount: 5 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PricingRow;
    expect(body.mode).toBe("per_1k_tokens");
    expect(body.price_amount).toBe(5);
    expect(body.currency).toBe("credits"); // default
    expect(db.rows.get("pub-1")?.mode).toBe("per_1k_tokens");
  });

  it("rejects an unknown mode with 422", async () => {
    const req = makeApp(db);
    const res = await req("/pub-1/pricing", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "bogus", price_amount: 5 }),
    });
    expect(res.status).toBe(422);
    expect(db.rows.size).toBe(0);
  });

  it("rejects a negative price_amount with 422", async () => {
    const req = makeApp(db);
    const res = await req("/pub-1/pricing", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "per_message", price_amount: -1 }),
    });
    expect(res.status).toBe(422);
  });

  it("404s when the publication isn't owned by the tenant", async () => {
    const req = makeApp(db, { owned: new Set() });
    const res = await req("/pub-x/pricing", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "per_message", price_amount: 2 }),
    });
    expect(res.status).toBe(404);
    expect(db.rows.size).toBe(0);
  });

  it("GET returns a free default when no pricing is set", async () => {
    const req = makeApp(db);
    const res = await req("/pub-1/pricing");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mode: string; price_amount: number };
    expect(body.mode).toBe("free");
    expect(body.price_amount).toBe(0);
  });

  it("GET reflects a prior PUT", async () => {
    const req = makeApp(db);
    await req("/pub-1/pricing", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "per_message", price_amount: 3 }),
    });
    const res = await req("/pub-1/pricing");
    const body = (await res.json()) as { mode: string; price_amount: number };
    expect(body.mode).toBe("per_message");
    expect(body.price_amount).toBe(3);
  });

  it("re-PUT preserves id + created_at (idempotent upsert)", async () => {
    const req = makeApp(db);
    await req("/pub-1/pricing", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "per_message", price_amount: 1 }),
    });
    const first = db.rows.get("pub-1")!;
    await req("/pub-1/pricing", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "per_1k_tokens", price_amount: 9 }),
    });
    const second = db.rows.get("pub-1")!;
    expect(second.id).toBe(first.id);
    expect(second.created_at).toBe(first.created_at);
    expect(second.mode).toBe("per_1k_tokens");
    expect(second.price_amount).toBe(9);
  });
});
