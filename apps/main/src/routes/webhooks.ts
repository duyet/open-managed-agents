import { Hono } from "hono";
import type { Env } from "@duyet/oma-shared";
import { WebhookDispatcher } from "@duyet/oma-webhooks";
import type { WebhookStore, WebhookDeliveryStore } from "@duyet/oma-webhooks";
import type { WebhookConfig } from "@duyet/oma-webhooks";
import type { WebhookDelivery } from "@duyet/oma-webhooks";

// KV-backed webhook store for the Cloudflare deployment.
function createCfWebhookStore(kv: KVNamespace): WebhookStore {
  const key = (id: string) => `webhook:${id}`;
  const listKey = (tenantId?: string) => `t:${tenantId ?? "_global"}:webhooks`;

  return {
    async list(tenantId?: string): Promise<WebhookConfig[]> {
      const raw = await kv.get(listKey(tenantId), "json");
      return (raw as WebhookConfig[]) ?? [];
    },

    async get(id: string): Promise<WebhookConfig | null> {
      const raw = await kv.get(key(id), "json");
      return (raw as WebhookConfig) ?? null;
    },

    async create(config: WebhookConfig): Promise<void> {
      await kv.put(key(config.id), JSON.stringify(config));
      const tenantKey = listKey(config.tenant_id);
      const existing = (await kv.get(tenantKey, "json")) as WebhookConfig[] ?? [];
      existing.push(config);
      await kv.put(tenantKey, JSON.stringify(existing));
    },

    async update(id: string, fields: Partial<WebhookConfig>): Promise<void> {
      const existing = await kv.get(key(id), "json") as WebhookConfig | null;
      if (!existing) return;
      const updated = { ...existing, ...fields };
      await kv.put(key(id), JSON.stringify(updated));
    },

    async delete(id: string): Promise<void> {
      const config = await kv.get(key(id), "json") as WebhookConfig | null;
      if (!config) return;
      await kv.delete(key(id));
      const tenantKey = listKey(config.tenant_id);
      const existing = (await kv.get(tenantKey, "json")) as WebhookConfig[] ?? [];
      const updated = existing.filter((w) => w.id !== id);
      await kv.put(tenantKey, JSON.stringify(updated));
    },
  };
}

function createCfWebhookDeliveryStore(kv: KVNamespace): WebhookDeliveryStore {
  return {
    async create(delivery: WebhookDelivery): Promise<void> {
      await kv.put(`webhook_delivery:${delivery.id}`, JSON.stringify(delivery));
    },

    async update(id: string, fields: Partial<WebhookDelivery>): Promise<void> {
      const existing = await kv.get(`webhook_delivery:${id}`, "json") as WebhookDelivery | null;
      if (!existing) return;
      const updated = { ...existing, ...fields };
      await kv.put(`webhook_delivery:${id}`, JSON.stringify(updated));
    },
  };
}

const app = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string };
}>();

// POST /v1/webhooks — Register a webhook
app.post("/", async (c) => {
  const t = c.get("tenant_id");
  const body = (await c.req.json()) as {
    url: string;
    events: string[];
    secret?: string;
    retry_count?: number;
    timeout_ms?: number;
  };

  if (!body.url || !body.events || !Array.isArray(body.events) || body.events.length === 0) {
    return c.json({ error: "url and events (non-empty array) are required" }, 400);
  }

  const validEvents = [
    "session.created", "session.completed", "session.error",
    "box.created", "box.destroyed", "box.error",
    "provider.healthy", "provider.unhealthy",
  ];
  for (const e of body.events) {
    if (!validEvents.includes(e)) {
      return c.json({ error: `Invalid event type: ${e}` }, 400);
    }
  }

  const id = `wh_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const now = new Date().toISOString();

  const config: WebhookConfig = {
    id,
    url: body.url,
    secret: body.secret,
    events: body.events as WebhookConfig["events"],
    retry_count: body.retry_count ?? 3,
    timeout_ms: body.timeout_ms ?? 10000,
    tenant_id: t,
    created_at: now,
    updated_at: now,
  };

  const kv = c.env.CONFIG_KV as unknown as KVNamespace;
  const store = createCfWebhookStore(kv);
  await store.create(config);

  return c.json(
    {
      id: config.id,
      url: config.url,
      events: config.events,
      has_secret: !!config.secret,
      retry_count: config.retry_count,
      timeout_ms: config.timeout_ms,
      created_at: config.created_at,
    },
    201,
  );
});

// GET /v1/webhooks — List webhooks
app.get("/", async (c) => {
  const t = c.get("tenant_id");
  const kv = c.env.CONFIG_KV as unknown as KVNamespace;
  const store = createCfWebhookStore(kv);
  const all = await store.list(t);

  const webhooks = all.map((w) => ({
    id: w.id,
    url: w.url,
    events: w.events,
    has_secret: !!w.secret,
    retry_count: w.retry_count,
    timeout_ms: w.timeout_ms,
    created_at: w.created_at,
  }));

  return c.json({ data: webhooks });
});

// DELETE /v1/webhooks/:id — Remove webhook
app.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const kv = c.env.CONFIG_KV as unknown as KVNamespace;
  const store = createCfWebhookStore(kv);
  const existing = await store.get(id);

  if (!existing) return c.json({ error: "Webhook not found" }, 404);

  await store.delete(id);
  return c.json({ ok: true, id });
});

export default app;
export { createCfWebhookStore, createCfWebhookDeliveryStore };
export type { WebhookStore, WebhookDeliveryStore };
