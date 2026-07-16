import { describe, expect, it, vi } from "vitest";
import { buildTelegramWebhookRoute } from "./index";
import type { TelegramAgentHandler, TelegramUpdate } from "@duyet/oma-telegram";

function fakeHandler(overrides: Partial<TelegramAgentHandler> = {}): TelegramAgentHandler {
  return {
    handleUpdate: vi.fn().mockResolvedValue(undefined),
    getSessionForChat: vi.fn(),
    ...overrides,
  } as unknown as TelegramAgentHandler;
}

function makeUpdate(overrides: Partial<TelegramUpdate> = {}): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      chat: { id: 42, type: "private" },
      date: 1000,
      text: "hello",
    },
    ...overrides,
  };
}

describe("buildTelegramWebhookRoute", () => {
  it("calls handleUpdate with the parsed update and returns 200", async () => {
    const handler = fakeHandler();
    const app = buildTelegramWebhookRoute({ buildHandler: () => handler });

    const update = makeUpdate();
    const res = await app.request("/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(update),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(handler.handleUpdate).toHaveBeenCalledWith(update);
  });

  it("returns 503 when buildHandler returns null", async () => {
    const app = buildTelegramWebhookRoute({ buildHandler: () => null });

    const res = await app.request("/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(makeUpdate()),
    });

    expect(res.status).toBe(503);
  });

  it("returns 401 when a secret is configured and the header is missing", async () => {
    const handler = fakeHandler();
    const app = buildTelegramWebhookRoute({ buildHandler: () => handler, webhookSecret: "wh-secret" });

    const res = await app.request("/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(makeUpdate()),
    });

    expect(res.status).toBe(401);
    expect(handler.handleUpdate).not.toHaveBeenCalled();
  });

  it("returns 401 when a secret is configured and the header doesn't match", async () => {
    const handler = fakeHandler();
    const app = buildTelegramWebhookRoute({ buildHandler: () => handler, webhookSecret: "wh-secret" });

    const res = await app.request("/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "wrong",
      },
      body: JSON.stringify(makeUpdate()),
    });

    expect(res.status).toBe(401);
    expect(handler.handleUpdate).not.toHaveBeenCalled();
  });

  it("returns 200 when the secret header matches", async () => {
    const handler = fakeHandler();
    const app = buildTelegramWebhookRoute({ buildHandler: () => handler, webhookSecret: "wh-secret" });

    const res = await app.request("/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "wh-secret",
      },
      body: JSON.stringify(makeUpdate()),
    });

    expect(res.status).toBe(200);
    expect(handler.handleUpdate).toHaveBeenCalledTimes(1);
  });

  it("returns 200 when no secret is configured and no header is sent", async () => {
    const handler = fakeHandler();
    const app = buildTelegramWebhookRoute({ buildHandler: () => handler });

    const res = await app.request("/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(makeUpdate()),
    });

    expect(res.status).toBe(200);
    expect(handler.handleUpdate).toHaveBeenCalledTimes(1);
  });

  it("never re-delivers: malformed JSON body still returns 200", async () => {
    const handler = fakeHandler();
    const app = buildTelegramWebhookRoute({ buildHandler: () => handler });

    const res = await app.request("/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false });
    expect(handler.handleUpdate).not.toHaveBeenCalled();
  });

  it("never re-delivers: handleUpdate throwing still returns 200", async () => {
    const handler = fakeHandler({ handleUpdate: vi.fn().mockRejectedValue(new Error("boom")) });
    const app = buildTelegramWebhookRoute({ buildHandler: () => handler });

    const res = await app.request("/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(makeUpdate()),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
