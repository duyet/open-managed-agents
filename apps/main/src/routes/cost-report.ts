import { Hono } from "hono";
import type { Env } from "@duyet/oma-shared";
import type { Services } from "@duyet/oma-services";
import {
  generateCostReport,
  DEFAULT_PRICING,
  type CfPricing,
} from "@duyet/oma-cf-billing";

const PRICING_KV_KEY = "system:cf_pricing";

const app = new Hono<{ Bindings: Env; Variables: { tenant_id: string; services: Services } }>();

app.get("/", async (c) => {
  const token = c.env.CLOUDFLARE_API_TOKEN;
  const accountId = c.env.CLOUDFLARE_ACCOUNT_ID;
  // Degrade gracefully when the Cloudflare GraphQL cost credentials aren't
  // configured on this deployment. Returning 200 (not 501) keeps the Usage
  // page's other sections — sandbox time, model tokens, per-agent breakdown,
  // none of which need CF creds — rendering normally; the console dispatches
  // on `available: false` to show a quiet inline note on the infra-cost card
  // rather than surfacing a page-level (toast) error.
  if (!token || !accountId) {
    return c.json({ available: false, reason: "cloudflare_credentials_not_configured" });
  }

  const days = Math.min(90, Math.max(1, parseInt(c.req.query("days") ?? "30", 10) || 30));

  const stored = await c.var.services.kv.get(PRICING_KV_KEY);
  const pricing: CfPricing = stored ? JSON.parse(stored) : DEFAULT_PRICING;

  const report = await generateCostReport(accountId, token, days, pricing);
  return c.json({ available: true, ...report });
});

app.get("/pricing", async (c) => {
  const stored = await c.var.services.kv.get(PRICING_KV_KEY);
  return c.json({
    source: stored ? "custom" : "default",
    pricing: stored ? JSON.parse(stored) : DEFAULT_PRICING,
  });
});

app.put("/pricing", async (c) => {
  const body = await c.req.json<Partial<CfPricing>>();
  const stored = await c.var.services.kv.get(PRICING_KV_KEY);
  const current: CfPricing = stored ? JSON.parse(stored) : { ...DEFAULT_PRICING };

  for (const [service, rates] of Object.entries(body)) {
    if (service in current) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (current as any)[service] = { ...(current as any)[service], ...rates };
    }
  }

  await c.var.services.kv.put(PRICING_KV_KEY, JSON.stringify(current));
  return c.json({ pricing: current });
});

app.delete("/pricing", async (c) => {
  await c.var.services.kv.delete(PRICING_KV_KEY);
  return c.json({ pricing: DEFAULT_PRICING, source: "default" });
});

export default app;
