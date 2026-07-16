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
import type { Context } from "hono";
import { z } from "zod";
import { nanoid } from "nanoid";
import { getLogger } from "@duyet/oma-observability";
import { computeNextRunAsync } from "@duyet/oma-scheduler/jobs/scheduled-agent-runs";
import { clampLimit, encodeCursor, decodeCursor, parseStringArray } from "@duyet/oma-shared";
import type { Env } from "@duyet/oma-shared";
import { getCfServicesForTenant } from "@duyet/oma-services";
import { launchDeploymentSession, type DeploymentRunConfig } from "../lib/deployment-runs";
import { rateLimitDeploymentHook } from "../rate-limit";

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

function parseTrigger(raw: string | null): unknown {
  if (!raw) return { type: "manual" };
  try {
    return JSON.parse(raw);
  } catch {
    return { type: "manual" };
  }
}

function webhookUrl(c: Context<HonoEnv>, hookToken: string | null): string | undefined {
  if (!hookToken) return undefined;
  const base =
    (c.env as unknown as { PUBLIC_BASE_URL?: string }).PUBLIC_BASE_URL || new URL(c.req.url).origin;
  return `${base.replace(/\/$/, "")}/v1/deployment_hooks/${hookToken}`;
}

function toApiDeployment(c: Context<HonoEnv>, row: DeploymentRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    agent_id: row.agent_id,
    agent_version: row.agent_version,
    environment_id: row.environment_id,
    vault_ids: parseStringArray(row.vault_ids),
    memory_store_ids: parseStringArray(row.memory_store_ids),
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
    vaultIds: parseStringArray(row.vault_ids),
    memoryStoreIds: parseStringArray(row.memory_store_ids),
    initialMessage: row.initial_message,
  };
}

function getDb(c: Context<HonoEnv>): D1Database {
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

// Validate that the agent, pinned version, and environment a deployment
// references actually exist — so a typo'd or stale id fails at create/update
// (404/422) instead of silently persisting a deployment that can never run.
// Agents + environments live in the per-tenant shard, so this resolves
// tenant-shard services (unlike the rest of this route, which only touches
// MAIN_DB). Returns an error descriptor to surface, or null when all refs
// resolve.
async function validateDeploymentRefs(
  env: Env,
  tenantId: string,
  refs: { agentId: string; agentVersion?: number | null; environmentId: string },
): Promise<{ status: 404 | 422; error: string } | null> {
  const services = await getCfServicesForTenant(env, tenantId);
  const agent = await services.agents.get({ tenantId, agentId: refs.agentId });
  if (!agent) return { status: 404, error: "agent not found" };
  // A pin equal to the live version has no history row (getVersion returns
  // null only for the current version), so only verify when it differs.
  if (typeof refs.agentVersion === "number" && refs.agentVersion !== agent.version) {
    const pinned = await services.agents.getVersion({
      tenantId,
      agentId: refs.agentId,
      version: refs.agentVersion,
    });
    if (!pinned) return { status: 422, error: `agent version ${refs.agentVersion} not found` };
  }
  const environment = await services.environments.get({
    tenantId,
    environmentId: refs.environmentId,
  });
  if (!environment) return { status: 404, error: "environment not found" };
  return null;
}

// Shared "launch a run → record last_run_* ok/error" body used by BOTH the
// manual run route and the webhook endpoint. They differ only in auth and how
// they resolve the row; the bookkeeping is identical, so it lives here once.
async function executeDeploymentRun(
  db: D1Database,
  env: Env,
  cfg: DeploymentRunConfig,
  message: string,
): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> {
  const ranAtIso = new Date().toISOString();
  try {
    const { sessionId } = await launchDeploymentSession(env, cfg, { message });
    await db
      .prepare(
        "UPDATE deployments SET last_run_at = ?, last_run_status = 'ok', last_run_error = NULL, last_session_id = ?, updated_at = ? WHERE id = ?",
      )
      .bind(ranAtIso, sessionId, ranAtIso, cfg.id)
      .run();
    return { ok: true, sessionId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db
      .prepare(
        "UPDATE deployments SET last_run_at = ?, last_run_status = 'error', last_run_error = ?, updated_at = ? WHERE id = ?",
      )
      .bind(ranAtIso, msg, ranAtIso, cfg.id)
      .run();
    log.warn({ deployment_id: cfg.id, err: msg }, "deployment run failed");
    return { ok: false, error: msg };
  }
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
  const refErr = await validateDeploymentRefs(c.env, tenantId, {
    agentId: d.agent_id,
    agentVersion: d.agent_version,
    environmentId: d.environment_id,
  });
  if (refErr) return c.json({ error: refErr.error }, refErr.status);
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
  // Optional per-agent scoping — powers the agent hub's Deployments tab.
  const agentId = c.req.query("agent_id");
  if (agentId) {
    where += " AND agent_id = ?";
    binds.push(agentId);
  }
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
  // Re-validate references when the pinned version or environment changes.
  // agent_id itself isn't patchable, so it's taken from the existing row.
  if (d.agent_version !== undefined || d.environment_id !== undefined) {
    const refErr = await validateDeploymentRefs(c.env, tenantId, {
      agentId: existing.agent_id,
      agentVersion: d.agent_version !== undefined ? d.agent_version : existing.agent_version,
      environmentId: d.environment_id ?? existing.environment_id,
    });
    if (refErr) return c.json({ error: refErr.error }, refErr.status);
  }
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
  const result = await executeDeploymentRun(db, c.env, cfg, message);
  if (!result.ok) return c.json({ error: "Deployment run failed", detail: result.error }, 500);
  return c.json({ session_id: result.sessionId, deployment_id: id, status: "running" }, 201);
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
  const db = getDb(c);

  const row = await db
    .prepare("SELECT * FROM deployments WHERE hook_token = ?")
    .bind(hookToken)
    .first<DeploymentRow>();
  // Ambiguous 404 on a bad/unknown token — don't leak whether a token exists.
  if (!row) return c.json({ error: "Not found" }, 404);
  if (row.enabled !== 1) return c.json({ error: "Deployment disabled" }, 403);

  // Unauthenticated + spins up a sandbox session per call — rate-limit per
  // deployment so a leaked token can't fan out unbounded runs. 429 on exhaustion.
  const limited = await rateLimitDeploymentHook(c.env, row.id);
  if (limited) return limited;

  const body = await c.req.json().catch(() => ({}));
  const parsed = runBodySchema.safeParse(body ?? {});
  if (!parsed.success) {
    return c.json({ error: "Invalid input", details: parsed.error.flatten() }, 422);
  }

  const message = resolveMessage(row.initial_message, parsed.data);
  const result = await executeDeploymentRun(db, c.env, toRunConfig(row), message);
  if (!result.ok) return c.json({ error: "Deployment run failed", detail: result.error }, 500);
  return c.json({ session_id: result.sessionId, deployment_id: row.id, status: "running" }, 201);
});

export const deploymentHooksRoutes = hooks;
