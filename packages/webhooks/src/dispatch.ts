import type { WebhookConfig, WebhookEventType, WebhookPayload, WebhookDelivery } from "./types";

export interface WebhookStore {
  list(tenantId?: string): Promise<WebhookConfig[]>;
  get(id: string): Promise<WebhookConfig | null>;
  create(config: WebhookConfig): Promise<void>;
  update(id: string, config: Partial<WebhookConfig>): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface WebhookDeliveryStore {
  create(delivery: WebhookDelivery): Promise<void>;
  update(id: string, fields: Partial<WebhookDelivery>): Promise<void>;
}

export class WebhookDispatcher {
  private store: WebhookStore;
  private deliveryStore: WebhookDeliveryStore;

  constructor(store: WebhookStore, deliveryStore: WebhookDeliveryStore) {
    this.store = store;
    this.deliveryStore = deliveryStore;
  }

  async dispatch(event: WebhookEventType, payload: unknown, tenantId?: string): Promise<void> {
    const configs = await this.store.list(tenantId);
    const matching = configs.filter(
      (c) => c.events.includes(event) && (!c.tenant_id || !tenantId || c.tenant_id === tenantId),
    );

    if (matching.length === 0) return;

    await Promise.allSettled(
      matching.map((config) => this.deliverWithRetry(config, event, payload)),
    );
  }

  private async deliverWithRetry(
    config: WebhookConfig,
    event: WebhookEventType,
    payload: unknown,
  ): Promise<void> {
    const deliveryId = crypto.randomUUID();
    const delivery: WebhookDelivery = {
      id: deliveryId,
      webhook_id: config.id,
      event,
      url: config.url,
      status: "pending",
      attempt: 0,
      max_attempts: config.retry_count + 1,
      duration_ms: 0,
      created_at: new Date().toISOString(),
    };

    await this.deliveryStore.create(delivery).catch(() => {});

    let lastError: string | undefined;
    let lastStatusCode: number | undefined;
    const maxAttempts = config.retry_count + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const start = performance.now();
      try {
        const body: WebhookPayload = {
          event,
          timestamp: new Date().toISOString(),
          webhook_id: config.id,
          delivery_id: deliveryId,
          data: payload,
        };

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.timeout_ms);

        const headers: Record<string, string> = { "content-type": "application/json" };
        if (config.secret) {
          headers["x-webhook-signature"] = await this.sign(body, config.secret);
        }

        const res = await fetch(config.url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        clearTimeout(timeout);
        const durationMs = Math.round(performance.now() - start);

        lastStatusCode = res.status;
        delivery.status = res.ok ? "delivered" : "failed";
        delivery.attempt = attempt;
        delivery.duration_ms = durationMs;

        if (res.ok) {
          await this.deliveryStore.update(deliveryId, {
            status: "delivered",
            status_code: res.status,
            attempt,
            duration_ms: durationMs,
          }).catch(() => {});
          return;
        }

        lastError = `HTTP ${res.status}`;
        if (attempt < maxAttempts) {
          await this.backoff(attempt);
        }
      } catch (err) {
        const durationMs = Math.round(performance.now() - start);
        lastError = err instanceof Error ? err.message : String(err);
        delivery.status = "failed";
        delivery.attempt = attempt;
        delivery.duration_ms = durationMs;

        if (attempt < maxAttempts) {
          await this.backoff(attempt);
        }
      }
    }

    delivery.status = "failed";
    delivery.error = lastError;
    delivery.status_code = lastStatusCode;
    await this.deliveryStore.update(deliveryId, {
      status: "failed",
      status_code: lastStatusCode,
      error: lastError,
      attempt: maxAttempts,
      duration_ms: delivery.duration_ms,
    }).catch(() => {});
  }

  async register(config: WebhookConfig): Promise<void> {
    await this.store.create(config);
  }

  async unregister(id: string): Promise<void> {
    await this.store.delete(id);
  }

  private async sign(payload: WebhookPayload, secret: string): Promise<string> {
    const data = new TextEncoder().encode(JSON.stringify(payload));
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, data);
    return Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  private async backoff(attempt: number): Promise<void> {
    const ms = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
    await new Promise((r) => setTimeout(r, ms));
  }
}
