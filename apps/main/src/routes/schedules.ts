import { Hono } from "hono";
import { z } from "zod";
import { nanoid } from "nanoid";
import { getLogger } from "@duyet/oma-observability";

const log = getLogger("schedules");

interface Env {
  Bindings: {
    MAIN_DB: D1Database;
  };
  Variables: {
    tenant_id: string;
    user_id?: string;
  };
}

const app = new Hono<Env>();

const createSchema = z.object({
  cron_expression: z.string().regex(/^(\S+\s+){4}\S+$/, "Must be a valid 5-field cron expression"),
  input: z.string().min(1).max(10000),
  max_sessions: z.number().int().positive().max(100).optional().default(1),
  enabled: z.boolean().optional().default(true),
});

async function getDb(c: import("hono").Context<Env>) {
  const env = c.env as unknown as { MAIN_DB?: D1Database };
  if (!env.MAIN_DB) throw new Error("MAIN_DB not configured");
  return env.MAIN_DB;
}

app.post("/:agentId/schedules", async (c) => {
  const agentId = c.req.param("agentId");
  const tenantId = c.var.tenant_id;
  const body = await c.req.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid input", details: parsed.error.flatten() }, 400);
  }

  const db = await getDb(c);
  const id = `sch_${nanoid(24)}`;
  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO agent_schedules (id, agent_id, tenant_id, cron_expression, input, max_sessions, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, agentId, tenantId, parsed.data.cron_expression, parsed.data.input, parsed.data.max_sessions, parsed.data.enabled ? 1 : 0, now, now)
    .run();

  log.info({ schedule_id: id, agent_id: agentId, cron: parsed.data.cron_expression }, "schedule created");

  return c.json({
    id,
    agent_id: agentId,
    cron_expression: parsed.data.cron_expression,
    input: parsed.data.input,
    max_sessions: parsed.data.max_sessions,
    enabled: parsed.data.enabled,
    created_at: now,
    updated_at: now,
  }, 201);
});

app.get("/:agentId/schedules", async (c) => {
  const agentId = c.req.param("agentId");
  const tenantId = c.var.tenant_id;
  const db = await getDb(c);

  const rows = await db
    .prepare("SELECT * FROM agent_schedules WHERE agent_id = ? AND tenant_id = ? ORDER BY created_at DESC")
    .bind(agentId, tenantId)
    .all();

  return c.json({ data: rows.results });
});

app.delete("/:agentId/schedules/:scheduleId", async (c) => {
  const scheduleId = c.req.param("scheduleId");
  const tenantId = c.var.tenant_id;
  const db = await getDb(c);

  const existing = await db
    .prepare("SELECT id FROM agent_schedules WHERE id = ? AND tenant_id = ?")
    .bind(scheduleId, tenantId)
    .first();

  if (!existing) {
    return c.json({ error: "Schedule not found" }, 404);
  }

  await db
    .prepare("DELETE FROM agent_schedules WHERE id = ?")
    .bind(scheduleId)
    .run();

  log.info({ schedule_id: scheduleId }, "schedule deleted");

  return c.json({ status: "deleted" }, 200);
});

export default app;
