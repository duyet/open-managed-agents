// Agent deployments — a first-class "deployment" concept (matches the
// official Claude Console). A deployment binds an agent (optionally pinned to
// a version) to an environment, credential vaults, memory stores, an initial
// message, and a trigger, so it can be run repeatedly.
//
// Triggers:
//   - manual   : POST /v1/deployments/:id/run creates a session now.
//   - webhook  : POST /v1/deployment_hooks/:hook_token (unauthenticated but
//                token-secured — see deploymentHooksRoutes below) fires a run.
//   - schedule : the scheduled-deployment-runs cron tick fires it on a cron
//                cadence (mirrors agent_schedules).
//
// Rows live in the shared control-plane D1 (MAIN_DB), tenant-scoped —
// deployments are CF-only today, same as agent_schedules.

import { Hono } from "hono";
import { z } from "zod";
import { nanoid } from "nanoid";
import { getLogger } from "@duyet/oma-observability";
import { computeNextRunAsync } from "@duyet/oma-scheduler/jobs/scheduled-agent-runs";
import { clampLimit, encodeCursor, decodeCursor } from "@duyet/oma-shared";
import type { Env } from "@duyet/oma-shared";
import { launchDeploymentSession, type DeploymentRunConfig } from "../lib/deployment-runs";

const log = getLogger("deployments");

interface HonoEnv {
  Bindings: Env;
  Variables: {
    tenant_id: string;
    user_id?: string;
  };
}

// ─── Schemas ────────────────────────────────────────────────────────────────

const triggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("manual") }),
  z.object({
    type: z.literal("schedule"),
    cron_expression: z.string().regex(/^(\S+\s+){4}\S+$/, "Must be a valid 5-field cron expression"),
    timezone: z.string().min(1).max(64).optional().default("UTC"),
  }),
  z.object({ type: z.literal("webhook") }),
]);

const createSchema = z.object({
  name: z.string().min(1).max(200),
  agent_id: z.string().min(1),
  agent_version: z.number().int().positive().nullable().optional(),
  initial_message: z.string().min(1).max(10000),
  environment_id: z.string().min(1),
  vault_ids: z.array(z.string().min(1)).optional().default([]),
  memory_store_ids: z.array(z.string().min(1)).optional().default([]),
  trigger: triggerSchema.optional().default({ type: "manual" }),
  enabled: z.boolean().optional().default(true),
});

const patchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  agent_version: z.number().int().positive().nullable().optional(),
  initial_message: z.string().min(1).max(10000).optional(),
  environment_id: z.string().min(1).optional(),
  vault_ids: z.array(z.string().min(1)).optional(),
  memory_store_ids: z.array(z.string().min(1)).optional(),
  trigger: triggerSchema.optional(),
  enabled: z.boolean().optional(),
});

// ─── Row <-> wire ─────────────────────────────────────────────────────────

interface DeploymentRow {
  id: string;
  tenant_id: string;
  name: string;
  agent_id: string;
  agent_version: number | null;
  environment_id: string;
  vault_ids: string | null;
  memory_store_ids: string | null;
  initial_message: string;
  trigger: string | null;
  hook_token: string | null;
  user_id: string | null;
  enabled: number;
  next_run_at: string | null;
  last_run_at: string | null;
  last_run_status: string | null;
  last_run_error: string | null;
  last_session_id: string | null;
  created_at: string;
  updated_at: string;
}

function parseIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function parseTrigger(raw: string | null): unknown {
  if (!raw) return { type: "manual" };
  try {
    return JSON.parse(raw);
  } catch {
    return { type: "manual" };
  }
}

function webhookUrl(c: import("hono").Context<HonoEnv>, hookToken: string | null): string | undefined {
  if (!hookToken) return undefined;
  const base =
    (c.env as unknown as { PUBLIC_BASE_URL?: string }).PUBLIC_BASE_URL || new URL(c.req.url).origin;
  return `${base.replace(/\/$/, "")}/v1/deployment_hooks/${hookToken}`;
}

function toApiDeployment(c: import("hono").Context<HonoEnv>, row: DeploymentRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    agent_id: row.agent_id,
    agent_version: row.agent_version,
    environment_id: row.environment_id,
    vault_ids: parseIds(row.vault_ids),
    memory_store_ids: parseIds(row.memory_store_ids),
    initial_message: row.initial_message,
    trigger: parseTrigger(row.trigger),
    webhook_url: webhookUrl(c, row.hook_token),
    enabled: row.enabled === 1,
    next_run_at: row.next_run_at,
    last_run_at: row.last_run_at,
    last_run_status: row.last_run_status,
    last_run_error: row.last_run_error,
    last_session_id: row.last_session_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toRunConfig(row: DeploymentRow): DeploymentRunConfig {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    agentVersion: row.agent_version,
    environmentId: row.environment_id,
    userId: row.user_id,
    vaultIds: parseIds(row.vault_ids),
    memoryStoreIds: parseIds(row.memory_store_ids),
    initialMessage: row.initial_message,
  };
}

function getDb(c: import("hono").Context<HonoEnv>): D1Database {
  const env = c.env as unknown as { MAIN_DB?: D1Database };
  if (!env.MAIN_DB) throw new Error("MAIN_DB not configured");
  return env.MAIN_DB;
}

// Seed next_run_at only for schedule triggers, from the cron + timezone.
async function seedNextRun(trigger: z.infer<typeof triggerSchema>, fromMs: number): Promise<string | null> {
  if (trigger.type !== "schedule") return null;
  const nextMs = await computeNextRunAsync(trigger.cron_expression, trigger.timezone, fromMs);
  return nextMs != null ? new Date(nextMs).toISOString() : null;
}

// ─── CRUD + manual run (tenant-scoped, mounted at /v1/deployments) ──────────

const app = new Hono<HonoEnv>();

app.post("/", async (c) => {
  const tenantId = c.var.tenant_id;
  const body = await c.req.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid input", details: parsed.error.flatten() }, 422);
  }
  const d = parsed.data;
  const db = getDb(c);
  const id = `dep_${nanoid(24)}`;
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const userId = c.var.user_id ?? null;
  const hookToken = d.trigger.type === "webhook" ? `dhk_${nanoid(32)}` : null;
  const nextRunAt = await seedNextRun(d.trigger, nowMs);

  await db
    .prepare(
      `INSERT INTO deployments
         (id, tenant_id, name, agent_id, agent_version, environment_id, vault_ids,
          memory_store_ids, initial_message, trigger, hook_token, user_id, enabled,
          next_run_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      tenantId,
      d.name,
      d.agent_id,
      d.agent_version ?? null,
      d.environment_id,
      JSON.stringify(d.vault_ids),
      JSON.stringify(d.memory_store_ids),
      d.initial_message,
      JSON.stringify(d.trigger),
      hookToken,
      userId,
      d.enabled ? 1 : 0,
      nextRunAt,
      now,
      now,
    )
    .run();

  log.info({ deployment_id: id, agent_id: d.agent_id, trigger: d.trigger.type }, "deployment created");

  const row = (await db
    .prepare("SELECT * FROM deployments WHERE id = ?")
    .bind(id)
    .first<DeploymentRow>())!;
  return c.json(toApiDeployment(c, row), 201);
});

app.get("/", async (c) => {
  const tenantId = c.var.tenant_id;
  const db = getDb(c);
  const limit = clampLimit(c.req.query("limit") ? Number(c.req.query("limit")) : undefined);
  const after = decodeCursor(c.req.query("cursor") ?? c.req.query("page"));

  let where = "tenant_id = ?";
  const binds: unknown[] = [tenantId];
  if (after) {
    where += " AND (created_at < ? OR (created_at = ? AND id < ?))";
    const afterIso = new Date(after.createdAt).toISOString();
    binds.push(afterIso, afterIso, after.id);
  }
  binds.push(limit + 1);

  const res = await db
    .prepare(`SELECT * FROM deployments WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .bind(...binds)
    .all<DeploymentRow>();

  const rows = res.results ?? [];
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeCursor({ createdAt: new Date(last.created_at).getTime(), id: last.id })
      : undefined;

  return c.json({ data: items.map((r) => toApiDeployment(c, r)), next_cursor: nextCursor });
});

app.get("/:id", async (c) => {
  const tenantId = c.var.tenant_id;
  const db = getDb(c);
  const row = await db
    .prepare("SELECT * FROM deployments WHERE id = ? AND tenant_id = ?")
    .bind(c.req.param("id"), tenantId)
    .first<DeploymentRow>();
  if (!row) return c.json({ error: "Deployment not found" }, 404);
  return c.json(toApiDeployment(c, row));
});

app.patch("/:id", async (c) => {
  const tenantId = c.var.tenant_id;
  const db = getDb(c);
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid input", details: parsed.error.flatten() }, 422);
  }
  const existing = await db
    .prepare("SELECT * FROM deployments WHERE id = ? AND tenant_id = ?")
    .bind(id, tenantId)
    .first<DeploymentRow>();
  if (!existing) return c.json({ error: "Deployment not found" }, 404);

  const d = parsed.data;
  const sets: string[] = [];
  const binds: unknown[] = [];
  const push = (col: string, val: unknown) => {
    sets.push(`${col} = ?`);
    binds.push(val);
  };
  if (d.name !== undefined) push("name", d.name);
  if (d.agent_version !== undefined) push("agent_version", d.agent_version ?? null);
  if (d.initial_message !== undefined) push("initial_message", d.initial_message);
  if (d.environment_id !== undefined) push("environment_id", d.environment_id);
  if (d.vault_ids !== undefined) push("vault_ids", JSON.stringify(d.vault_ids));
  if (d.memory_store_ids !== undefined) push("memory_store_ids", JSON.stringify(d.memory_store_ids));
  if (d.enabled !== undefined) push("enabled", d.enabled ? 1 : 0);
  if (d.trigger !== undefined) {
    push("trigger", JSON.stringify(d.trigger));
    // Re-mint / drop hook_token and re-seed next_run_at to match the new trigger.
    push("hook_token", d.trigger.type === "webhook" ? existing.hook_token ?? `dhk_${nanoid(32)}` : null);
    push("next_run_at", await seedNextRun(d.trigger, Date.now()));
  }
  const now = new Date().toISOString();
  push("updated_at", now);
  binds.push(id, tenantId);

  await db
    .prepare(`UPDATE deployments SET ${sets.join(", ")} WHERE id = ? AND tenant_id = ?`)
    .bind(...binds)
    .run();

  const row = (await db
    .prepare("SELECT * FROM deployments WHERE id = ?")
    .bind(id)
    .first<DeploymentRow>())!;
  return c.json(toApiDeployment(c, row));
});

app.delete("/:id", async (c) => {
  const tenantId = c.var.tenant_id;
  const db = getDb(c);
  const id = c.req.param("id");
  const existing = await db
    .prepare("SELECT id FROM deployments WHERE id = ? AND tenant_id = ?")
    .bind(id, tenantId)
    .first();
  if (!existing) return c.json({ error: "Deployment not found" }, 404);
  await db.prepare("DELETE FROM deployments WHERE id = ?").bind(id).run();
  log.info({ deployment_id: id }, "deployment deleted");
  return c.json({ status: "deleted" }, 200);
});

// Manual/API run — create a fresh session from the deployment config, inject
// the initial message, record the run. Reuses the shared launch path.
const runBodySchema = z.object({
  // Optional overrides for the opening message.
  message: z.string().min(1).max(10000).optional(),
  append: z.string().min(1).max(10000).optional(),
});

app.post("/:id/run", async (c) => {
  const tenantId = c.var.tenant_id;
  const db = getDb(c);
  const id = c.req.param("id");
  const row = await db
    .prepare("SELECT * FROM deployments WHERE id = ? AND tenant_id = ?")
    .bind(id, tenantId)
    .first<DeploymentRow>();
  if (!row) return c.json({ error: "Deployment not found" }, 404);

  const body = await c.req.json().catch(() => ({}));
  const parsed = runBodySchema.safeParse(body ?? {});
  if (!parsed.success) {
    return c.json({ error: "Invalid input", details: parsed.error.flatten() }, 422);
  }
  // Manual runs need an owner; fall back to the caller's user when the row has none.
  const cfg = toRunConfig(row);
  cfg.userId = cfg.userId ?? c.var.user_id ?? null;

  const message = resolveMessage(row.initial_message, parsed.data);
  const ranAtIso = new Date().toISOString();
  try {
    const { sessionId } = await launchDeploymentSession(c.env, cfg, { message });
    await db
      .prepare(
        "UPDATE deployments SET last_run_at = ?, last_run_status = 'ok', last_run_error = NULL, last_session_id = ?, updated_at = ? WHERE id = ?",
      )
      .bind(ranAtIso, sessionId, ranAtIso, id)
      .run();
    return c.json({ session_id: sessionId, deployment_id: id, status: "running" }, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db
      .prepare(
        "UPDATE deployments SET last_run_at = ?, last_run_status = 'error', last_run_error = ?, updated_at = ? WHERE id = ?",
      )
      .bind(ranAtIso, msg, ranAtIso, id)
      .run();
    log.warn({ deployment_id: id, err: msg }, "manual deployment run failed");
    return c.json({ error: "Deployment run failed", detail: msg }, 500);
  }
});

function resolveMessage(
  base: string,
  body: { message?: string; append?: string },
): string {
  if (body.message) return body.message;
  if (body.append) return `${base}\n${body.append}`;
  return base;
}

export default app;

// ─── Webhook endpoint (unauthenticated, token-secured) ──────────────────────
//
// Mounted at /v1/deployment_hooks — bypasses the x-api-key authMiddleware (see
// auth.ts). The opaque hook_token both identifies the deployment AND authorizes
// the run: NEVER accept a tenant API key here. The optional JSON body may
// override or append to the deployment's initial message.

const hooks = new Hono<HonoEnv>();

hooks.post("/:hook_token", async (c) => {
  const hookToken = c.req.param("hook_token");
  const env = c.env as unknown as { MAIN_DB?: D1Database };
  if (!env.MAIN_DB) return c.json({ error: "not configured" }, 500);

  const row = await env.MAIN_DB
    .prepare("SELECT * FROM deployments WHERE hook_token = ?")
    .bind(hookToken)
    .first<DeploymentRow>();
  // Ambiguous 404 on a bad/unknown token — don't leak whether a token exists.
  if (!row) return c.json({ error: "Not found" }, 404);
  if (row.enabled !== 1) return c.json({ error: "Deployment disabled" }, 403);

  const body = await c.req.json().catch(() => ({}));
  const parsed = runBodySchema.safeParse(body ?? {});
  if (!parsed.success) {
    return c.json({ error: "Invalid input", details: parsed.error.flatten() }, 422);
  }

  const message = resolveMessage(row.initial_message, parsed.data);
  const ranAtIso = new Date().toISOString();
  try {
    const { sessionId } = await launchDeploymentSession(c.env, toRunConfig(row), { message });
    await env.MAIN_DB
      .prepare(
        "UPDATE deployments SET last_run_at = ?, last_run_status = 'ok', last_run_error = NULL, last_session_id = ?, updated_at = ? WHERE id = ?",
      )
      .bind(ranAtIso, sessionId, ranAtIso, row.id)
      .run();
    return c.json({ session_id: sessionId, deployment_id: row.id, status: "running" }, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await env.MAIN_DB
      .prepare(
        "UPDATE deployments SET last_run_at = ?, last_run_status = 'error', last_run_error = ?, updated_at = ? WHERE id = ?",
      )
      .bind(ranAtIso, msg, ranAtIso, row.id)
      .run();
    log.warn({ deployment_id: row.id, err: msg }, "webhook deployment run failed");
    return c.json({ error: "Deployment run failed", detail: msg }, 500);
  }
});

export const deploymentHooksRoutes = hooks;
