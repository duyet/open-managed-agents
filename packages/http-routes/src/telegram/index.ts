// Shared Telegram webhook route factory — mounted by both apps/integrations
// (Cloudflare) and apps/main-node (self-host Node) so the request handling
// (secret verification, update parsing, always-200 error contract) lives in
// one place instead of being duplicated per runtime.
//
// The host supplies `buildHandler` (constructs the TelegramAgentHandler for
// this deployment, or returns null when the bot isn't configured) and an
// optional `webhookSecret` to gate the request against Telegram's
// `X-Telegram-Bot-Api-Secret-Token` header.

import { Hono } from "hono";
import type { TelegramUpdate, TelegramAgentHandler } from "@duyet/oma-telegram";
import { verifyTelegramWebhookSecret } from "@duyet/oma-telegram";

export interface TelegramWebhookRouteDeps {
  /** Constructs the handler for this request/deployment. Returns null when
   *  the bot isn't fully configured (missing token/agent binding) — the
   *  route surfaces a clear 503 rather than silently no-op'ing. */
  buildHandler: () => TelegramAgentHandler | null;
  /** When set, requests must present a matching `X-Telegram-Bot-Api-Secret-Token`
   *  header (constant-time compare). Unset — passthrough, matching prior
   *  behavior for deployments that haven't configured one. */
  webhookSecret?: string;
  log?: {
    debug(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
}

export function buildTelegramWebhookRoute(deps: TelegramWebhookRouteDeps) {
  const app = new Hono();

  app.post("/webhook", async (c) => {
    const verified = verifyTelegramWebhookSecret({
      configuredSecret: deps.webhookSecret,
      headerValue: c.req.header("X-Telegram-Bot-Api-Secret-Token"),
    });
    if (!verified.ok) {
      return c.json({ error: "invalid webhook secret" }, 401);
    }

    const handler = deps.buildHandler();
    if (!handler) {
      return c.json({ error: "telegram bot not configured" }, 503);
    }

    let update: TelegramUpdate;
    try {
      update = await c.req.json<TelegramUpdate>();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.log?.warn({ op: "telegram.webhook.failed", err: msg }, "failed to parse telegram update");
      return c.json({ ok: false, error: msg }, 200);
    }

    deps.log?.debug(
      { op: "telegram.webhook.received", updateId: update.update_id },
      "telegram update",
    );

    try {
      await handler.handleUpdate(update);
    } catch (err) {
      // Never re-deliver — log and 200, matching every other webhook
      // receiver in this app (Linear/GitHub/Slack).
      const msg = err instanceof Error ? err.message : String(err);
      deps.log?.error(
        { op: "telegram.webhook.handle_failed", updateId: update.update_id, err: msg },
        "failed to handle telegram update",
      );
    }

    return c.json({ ok: true });
  });

  return app;
}
