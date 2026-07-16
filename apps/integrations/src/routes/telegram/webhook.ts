import { Hono } from "hono";
import type { Env } from "../../env";
import type { TelegramUpdate } from "@duyet/oma-telegram";
import { verifyTelegramWebhookSecret } from "@duyet/oma-telegram";
import { getLogger } from "@duyet/oma-observability";
import { buildTelegramHandler } from "./wire";

// CF's per-request `c.env` access doesn't compose cleanly with
// @duyet/oma-http-routes' buildTelegramWebhookRoute factory (built once at
// module load, before any request's Bindings exist) — so this stays a thin
// route rather than delegating the whole handler. It still reuses
// verifyTelegramWebhookSecret from @duyet/oma-telegram for the actual
// secret check, so the constant-time comparison logic lives in exactly one
// place (shared with apps/main-node via the same package).

const log = getLogger("apps.integrations.routes.telegram.webhook");

const app = new Hono<{ Bindings: Env }>();

app.post("/webhook", async (c) => {
  const verified = verifyTelegramWebhookSecret({
    configuredSecret: c.env.TELEGRAM_WEBHOOK_SECRET,
    headerValue: c.req.header("X-Telegram-Bot-Api-Secret-Token"),
  });
  if (!verified.ok) {
    return c.json({ error: "invalid webhook secret" }, 401);
  }

  const handler = buildTelegramHandler(c.env);
  if (!handler) {
    return c.json({ error: "telegram bot not configured" }, 503);
  }

  let update: TelegramUpdate;
  try {
    update = await c.req.json<TelegramUpdate>();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ op: "telegram.webhook.failed", err: msg }, "failed to parse telegram update");
    return c.json({ ok: false, error: msg }, 200);
  }

  log.debug({ op: "telegram.webhook.received", updateId: update.update_id }, "telegram update");

  try {
    await handler.handleUpdate(update);
  } catch (err) {
    // Never re-deliver — log and 200, matching every other webhook receiver
    // in this app (Linear/GitHub/Slack).
    const msg = err instanceof Error ? err.message : String(err);
    log.error(
      { op: "telegram.webhook.handle_failed", updateId: update.update_id, err: msg },
      "failed to handle telegram update",
    );
  }

  return c.json({ ok: true });
});

export default app;
