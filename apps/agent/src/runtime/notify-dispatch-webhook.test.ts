import { describe, expect, it, vi } from "vitest";
import { FakeHttpClient } from "@duyet/oma-integrations-core/test-fakes";
import type { HttpClient } from "@duyet/oma-integrations-core";
import type { NotificationTarget } from "@duyet/oma-api-types";
import { dispatchSessionNotifications, signWebhookBody, buildWebhookEnvelope } from "./notify-dispatch";

// Minimal HMAC-SHA256 verifier (Node/CF Web Crypto) used to assert the
// signature we emit is independently verifiable by a receiver.
async function verifyHmac(body: string, secret: string, header: string): Promise<boolean> {
  const expected = await signWebhookBody(body, secret);
  return header === `sha256=${expected}`;
}

const webhookTarget: NotificationTarget = {
  type: "webhook",
  url: "https://hooks.example.com/agent",
  secret_ref: "cred_webhook_secret",
};

const event = {
  sessionId: "sess_1",
  status: "idle" as const,
  agentName: "Reviewer",
  publicationId: "pub_9",
  endUserId: "user_42",
  finalMessage: "Done — PR looks good.",
  sessionUrl: "https://console.example.com/sess_1",
};

function depsFor(map: Record<string, string | null>, overrides: Partial<{
  onError: (t: NotificationTarget, e: unknown) => void;
  webhookRateLimitGate: { consume: (k: string) => Promise<{ ok: boolean; retryAfter?: number }> };
  tenantId: string;
  httpClient: HttpClient;
  allowPrivateWebhookUrls: boolean;
}> = {}) {
  return {
    resolveCredentialToken: async (id?: string) => (id ? map[id] ?? null : null),
    resolveSecret: async (id?: string) => (id ? map[id] ?? null : null),
    httpClient: new FakeHttpClient(),
    tenantId: "tenant_a",
    ...overrides,
  };
}

describe("webhook notify target", () => {
  it("POSTs a signed JSON envelope whose HMAC is independently verifiable", async () => {
    const http = new FakeHttpClient();
    await dispatchSessionNotifications(event, [webhookTarget], depsFor({ cred_webhook_secret: "topsecret" }, { httpClient: http }));

    expect(http.calls).toHaveLength(1);
    const call = http.calls[0];
    expect(call.method).toBe("POST");
    expect(call.url).toBe("https://hooks.example.com/agent");
    expect(call.headers?.["content-type"]).toBe("application/json");
    expect(call.headers?.["x-oma-event"]).toBe("idle");

    const sig = call.headers?.["x-oma-signature"];
    expect(sig).toBeDefined();
    expect(await verifyHmac(call.body ?? "", "topsecret", sig as string)).toBe(true);

    const payload = JSON.parse(call.body ?? "") as Record<string, unknown>;
    expect(payload.session_id).toBe("sess_1");
    expect(payload.publication_id).toBe("pub_9");
    expect(payload.end_user_id).toBe("user_42");
    expect(payload.agent_name).toBe("Reviewer");
    expect(payload.status).toBe("idle");
    expect(payload.message).toBe("Done — PR looks good.");
    expect(payload.session_url).toBe("https://console.example.com/sess_1");
  });

  it("signature is deterministic byte-for-byte (fixed key/body order)", async () => {
    const a = new FakeHttpClient();
    const b = new FakeHttpClient();
    await dispatchSessionNotifications(event, [webhookTarget], depsFor({ cred_webhook_secret: "s" }, { httpClient: a }));
    await dispatchSessionNotifications(event, [webhookTarget], depsFor({ cred_webhook_secret: "s" }, { httpClient: b }));
    expect(a.calls[0].body).toBe(b.calls[0].body);
    expect(a.calls[0].headers?.["x-oma-signature"]).toBe(b.calls[0].headers?.["x-oma-signature"]);
  });

  it("honors the events filter — skips a status not in the list", async () => {
    const http = new FakeHttpClient();
    const filtered: NotificationTarget = { ...webhookTarget, events: ["terminated"] };
    await dispatchSessionNotifications(event, [filtered], depsFor({ cred_webhook_secret: "s" }, { httpClient: http }));
    expect(http.calls).toHaveLength(0);
  });

  it("delivers when the status is in the events filter", async () => {
    const http = new FakeHttpClient();
    const filtered: NotificationTarget = { ...webhookTarget, events: ["idle"] };
    await dispatchSessionNotifications(event, [filtered], depsFor({ cred_webhook_secret: "s" }, { httpClient: http }));
    expect(http.calls).toHaveLength(1);
  });

  it("resolves the secret via secret_ref (vault) — never inline", async () => {
    const http = new FakeHttpClient();
    http.setFallback({ status: 200, headers: {}, body: "" });
    const onError = vi.fn();
    // secret_ref resolves to a different value than credential_id lookups;
    // proves the secret comes from the vault resolveSecret path.
    await dispatchSessionNotifications(
      event,
      [{ type: "webhook", url: "https://x/y", secret_ref: "sec_1" }],
      {
        resolveCredentialToken: async () => null,
        resolveSecret: async (id) => (id === "sec_1" ? "vault-secret" : null),
        httpClient: http,
        onError,
      },
    );
    expect(http.calls).toHaveLength(1);
    expect(await verifyHmac(http.calls[0].body ?? "", "vault-secret", http.calls[0].headers?.["x-oma-signature"] as string)).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });

  it("sends unsigned + warns when no secret_ref is configured", async () => {
    const http = new FakeHttpClient();
    http.setFallback({ status: 200, headers: {}, body: "" });
    const onError = vi.fn();
    await dispatchSessionNotifications(
      event,
      [{ type: "webhook", url: "https://x/y" }],
      depsFor({}, { httpClient: http, onError }),
    );
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0].headers?.["x-oma-signature"]).toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("skips + reports when secret_ref is set but unresolved", async () => {
    const http = new FakeHttpClient();
    http.setFallback({ status: 200, headers: {}, body: "" });
    const onError = vi.fn();
    await dispatchSessionNotifications(
      event,
      [{ type: "webhook", url: "https://x/y", secret_ref: "missing" }],
      depsFor({}, { httpClient: http, onError }),
    );
    expect(http.calls).toHaveLength(0);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("rate-limits per tenant — skips delivery when the bucket is exhausted", async () => {
    const http = new FakeHttpClient();
    const onError = vi.fn();
    const gate = { consume: vi.fn(async () => ({ ok: false, retryAfter: 60 })) };
    await dispatchSessionNotifications(
      event,
      [webhookTarget],
      depsFor({ cred_webhook_secret: "s" }, { httpClient: http, onError, webhookRateLimitGate: gate, tenantId: "t1" }),
    );
    expect(gate.consume).toHaveBeenCalledWith("webhook:t1");
    expect(http.calls).toHaveLength(0);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("reports any >=400 response via onError", async () => {
    const http = new FakeHttpClient();
    http.setFallback({ status: 500, headers: {}, body: "boom" });
    const onError = vi.fn();
    await dispatchSessionNotifications(event, [webhookTarget], depsFor({ cred_webhook_secret: "s" }, { httpClient: http, onError }));
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("SSRF guard (#217): blocks a webhook.url pointing at a private/metadata host — reports via onError, never posts", async () => {
    const http = new FakeHttpClient();
    const onError = vi.fn();
    const privateTarget: NotificationTarget = {
      type: "webhook",
      url: "http://169.254.169.254/latest/meta-data/",
      secret_ref: "cred_webhook_secret",
    };
    await dispatchSessionNotifications(
      event,
      [privateTarget],
      depsFor({ cred_webhook_secret: "topsecret" }, { httpClient: http, onError }),
    );
    expect(http.calls).toHaveLength(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String((onError.mock.calls[0][1] as Error).message)).toContain("Blocked URL");
  });

  it("SSRF guard (#217): allowPrivateWebhookUrls opts a self-host deployment back in", async () => {
    const http = new FakeHttpClient();
    http.setFallback({ status: 200, headers: {}, body: "" });
    const onError = vi.fn();
    const loopbackTarget: NotificationTarget = {
      type: "webhook",
      url: "http://127.0.0.1:9000/hooks/agent",
      secret_ref: "cred_webhook_secret",
    };
    await dispatchSessionNotifications(
      event,
      [loopbackTarget],
      depsFor(
        { cred_webhook_secret: "topsecret" },
        { httpClient: http, onError, allowPrivateWebhookUrls: true },
      ),
    );
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0].url).toBe("http://127.0.0.1:9000/hooks/agent");
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("buildWebhookEnvelope", () => {
  it("omits optional fields when absent", () => {
    const env = buildWebhookEnvelope(
      { sessionId: "s1", status: "error" },
      { type: "webhook", url: "https://x" },
    );
    expect(env).toEqual({ session_id: "s1", status: "error" });
  });
});
