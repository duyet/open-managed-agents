// /v1/cost_report route tests.
//
// Regression: when the Cloudflare GraphQL cost credentials
// (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID) aren't configured on the
// deployment, the endpoint must degrade gracefully — return 200 with an
// `{ available: false, reason }` marker rather than a 501. A non-2xx here
// fired a page-level error toast on the console Usage page even though the
// rest of that page (sandbox time, model tokens) doesn't need CF creds.
//
// The happy path (creds present) reaches the real Cloudflare GraphQL API
// via generateCostReport, so it isn't unit-tested here (no network in the
// workers pool, and this suite follows the sibling usage.test's no-mock
// style) — only the deterministic not-configured degradation is covered.

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import costReportRoutes from "./cost-report";

// Tiny middleware stands in for the tenant/services wiring the real app
// installs — the not-configured branch returns before ever touching
// c.var.services, but we seed it anyway to mirror the real request shape.
function costApp() {
  const app = new Hono();
  app.use("/v1/cost_report/*", async (c, next) => {
    c.set("tenant_id" as never, "tenant-a" as never);
    c.set("services" as never, { kv: { get: async () => null } } as never);
    await next();
  });
  app.route("/v1/cost_report", costReportRoutes);
  return app;
}

const call = (app: Hono, path: string, bindings: Record<string, unknown>) =>
  app.request(path, undefined, bindings);

describe("GET /v1/cost_report — credentials not configured", () => {
  it("returns 200 with { available: false } instead of 501 when both creds are missing", async () => {
    const res = await call(costApp(), "/v1/cost_report", {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { available: boolean; reason: string };
    expect(body).toEqual({
      available: false,
      reason: "cloudflare_credentials_not_configured",
    });
  });

  it("degrades the same way when only the account id is missing", async () => {
    const res = await call(costApp(), "/v1/cost_report", { CLOUDFLARE_API_TOKEN: "tok" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { available: boolean; reason: string };
    expect(body.available).toBe(false);
    expect(body.reason).toBe("cloudflare_credentials_not_configured");
  });

  it("degrades the same way when only the api token is missing", async () => {
    const res = await call(costApp(), "/v1/cost_report", { CLOUDFLARE_ACCOUNT_ID: "acc" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { available: boolean; reason: string };
    expect(body.available).toBe(false);
    expect(body.reason).toBe("cloudflare_credentials_not_configured");
  });
});
