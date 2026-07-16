import { Hono } from "hono";
import type { Env } from "../../env";
import { TelegramClient } from "@duyet/oma-telegram";
import { getLogger } from "@duyet/oma-observability";

const log = getLogger("apps.integrations.routes.telegram.webhook");

const app = new Hono<{ Bindings: Env }>();

app.post("/webhook", async (c) => {
  const token = c.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return c.json({ error: "telegram bot not configured" }, 503);
  }

  try {
    const update = await c.req.json<{
      update_id: number;
      message?: Record<string, unknown>;
    }>();

    log.debug({ op: "telegram.webhook.received", updateId: update.update_id }, "telegram update");

    return c.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ op: "telegram.webhook.failed", err: msg }, "failed to parse telegram update");
    return c.json({ ok: false, error: msg }, 200);
  }
});

export default app;
