// Agent schedules CRUD — shared across CF (apps/main) and self-host Node
// (apps/main-node). Was apps/main/src/routes/schedules.ts (D1-only); moved
// here so both runtimes mount one implementation (issue #262).
//
// agent_schedules lives in the shared control-plane DB, which is NOT the
// per-request tenant shard `services.sql` exposes on CF — so this builder
// takes the control-plane SqlClient explicitly (a value on Node, a
// per-request resolver on CF that wraps env.MAIN_DB). The SqlClient port
// mirrors the D1 surface (prepare/bind/all/run/first + meta.changes), so the
// handler bodies are unchanged from the original D1 route.

import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { nanoid } from "nanoid";
import type { SqlClient } from "@duyet/oma-sql-client";
import { getLogger } from "@duyet/oma-observability";
import { computeNextRunAsync } from "@duyet/oma-scheduler/jobs/scheduled-agent-runs";

const log = getLogger("schedules");

interface Vars {
  Variables: { tenant_id: string; user_id?: string };
}

/** Control-plane DB: a fixed client (Node) or a per-request resolver (CF,
 *  which wraps env.MAIN_DB off the request context). */
export type ScheduleDbArg = SqlClient | ((c: Context) => SqlClient);

export interface ScheduleRoutesDeps {
  db: ScheduleDbArg;
}

function resolveDb(arg: ScheduleDbArg, c: Context): SqlClient {
  return typeof arg === "function" ? arg(c) : arg;
}

const createSchema = z.object({
  cron_expression: z.string().regex(/^(\S+\s+){4}\S+$/, "Must be a valid 5-field cron expression"),
  input: z.string().min(1).max(10000),
  // Required for the schedule to actually fire — the tick creates a session
  // in this environment (issue #77).
  environment_id: z.string().min(1),
  timezone: z.string().min(1).max(64).optional().default("UTC"),
  max_sessions: z.number().int().positive().max(100).optional().default(1),
  enabled: z.boolean().optional().default(true),
});

export function buildScheduleRoutes(deps: ScheduleRoutesDeps) {
  const app = new Hono<Vars>();

  app.post("/:agentId/schedules", async (c) => {
    const agentId = c.req.param("agentId");
    const tenantId = c.var.tenant_id;
    const body = await c.req.json().catch(() => ({}));
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid input", details: parsed.error.flatten() }, 400);
    }

    const db = resolveDb(deps.db, c);
    const id = `sch_${nanoid(24)}`;
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const userId = c.var.user_id ?? null;

    // Seed the first firing time from the cron+timezone so the tick can pick
    // the row up. Unparseable cron → null → never fires (guarded at select).
    const nextMs = await computeNextRunAsync(parsed.data.cron_expression, parsed.data.timezone, nowMs);
    const nextRunAt = nextMs != null ? new Date(nextMs).toISOString() : null;

    await db
      .prepare(
        `INSERT INTO agent_schedules
           (id, agent_id, tenant_id, cron_expression, input, environment_id, user_id, timezone, next_run_at, max_sessions, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        agentId,
        tenantId,
        parsed.data.cron_expression,
        parsed.data.input,
        parsed.data.environment_id,
        userId,
        parsed.data.timezone,
        nextRunAt,
        parsed.data.max_sessions,
        parsed.data.enabled ? 1 : 0,
        now,
        now,
      )
      .run();

    log.info({ schedule_id: id, agent_id: agentId, cron: parsed.data.cron_expression }, "schedule created");

    return c.json({
      id,
      agent_id: agentId,
      cron_expression: parsed.data.cron_expression,
      input: parsed.data.input,
      environment_id: parsed.data.environment_id,
      timezone: parsed.data.timezone,
      next_run_at: nextRunAt,
      max_sessions: parsed.data.max_sessions,
      enabled: parsed.data.enabled,
      created_at: now,
      updated_at: now,
    }, 201);
  });

  // Run now — nudge next_run_at to the current instant so the next cron tick
  // fires this schedule immediately (reuses the same idempotent firing path
  // rather than a second create path). Tenant-scoped.
  app.post("/:agentId/schedules/:scheduleId/run", async (c) => {
    const scheduleId = c.req.param("scheduleId");
    const tenantId = c.var.tenant_id;
    const db = resolveDb(deps.db, c);

    const now = new Date().toISOString();
    const res = await db
      .prepare("UPDATE agent_schedules SET next_run_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?")
      .bind(now, now, scheduleId, tenantId)
      .run();

    if ((res.meta?.changes ?? 0) === 0) {
      return c.json({ error: "Schedule not found" }, 404);
    }

    log.info({ schedule_id: scheduleId }, "schedule run-now requested");
    return c.json({ status: "queued", next_run_at: now }, 200);
  });

  app.get("/:agentId/schedules", async (c) => {
    const agentId = c.req.param("agentId");
    const tenantId = c.var.tenant_id;
    const db = resolveDb(deps.db, c);

    const rows = await db
      .prepare("SELECT * FROM agent_schedules WHERE agent_id = ? AND tenant_id = ? ORDER BY created_at DESC")
      .bind(agentId, tenantId)
      .all();

    return c.json({ data: rows.results });
  });

  app.delete("/:agentId/schedules/:scheduleId", async (c) => {
    const scheduleId = c.req.param("scheduleId");
    const tenantId = c.var.tenant_id;
    const db = resolveDb(deps.db, c);

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

  return app;
}
