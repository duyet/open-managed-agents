// CLI telemetry — public, unauthenticated, best-effort ingest + global stats.
//
//   POST /events  — CLI posts one anonymous command-usage event. Never fails
//                    the caller: insert errors are swallowed (telemetry must
//                    not break the CLI), only rate-limiting and schema
//                    validation produce a non-202 response.
//   GET  /stats    — public, tenant-agnostic aggregate counts for a stats
//                    page. Every aggregate is best-effort (wrapped so a
//                    missing/renamed table degrades to 0 instead of 500).
//
// Mounted at /v1/telemetry by both apps/main (CF) and apps/main-node.

import { Hono } from "hono";
import { z } from "zod";
import type { RouteServicesArg } from "../types";
import { resolveServices } from "../types";

interface Vars {
  Variables: { tenant_id?: string; user_id?: string };
}

const commandEventSchema = z
  .object({
    event: z.literal("command"),
    command: z
      .string()
      .regex(/^[a-z0-9._-]+$/)
      .max(64),
    cli_version: z.string().max(32),
    os: z.string().max(32),
    arch: z.string().max(32),
    node_version: z.string().max(32).optional(),
    machine_id: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

// Server-side install / deployment phone-home. Carries ONLY anonymous
// aggregates — see the migration + phone-home.ts for the privacy contract.
const countField = z.number().int().nonnegative().max(1e12).optional().default(0);
const installReportSchema = z
  .object({
    instance_id: z.string().uuid(),
    oma_version: z.string().max(32).optional(),
    deployment_kind: z.enum(["cloudflare", "node-docker", "k8s", "unknown"]),
    agents_total: countField,
    agents_active: countField,
    sessions_total: countField,
    sessions_running: countField,
    session_duration_total_ms: countField,
    session_duration_avg_ms: countField,
    idle_time_total_ms: countField,
    sandbox_launches: z
      .record(
        z
          .string()
          .regex(/^[a-z0-9-]+$/)
          .max(32),
        z.number().int().nonnegative(),
      )
      .refine((r) => Object.keys(r).length <= 32, {
        message: "sandbox_launches may not exceed 32 keys.",
      })
      .optional(),
    model_ids: z.array(z.string().max(128)).max(64).optional(),
  })
  .strict();

export interface TelemetryRoutesDeps {
  services: RouteServicesArg;
  /** Returns true when the caller should be rate-limited (429). Omit to
   *  rely on an outer middleware (e.g. CF's global /v1/* rate limiter). */
  rateLimit?: (c: import("hono").Context) => Promise<boolean>;
}

function genId(): string {
  return `tel_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function buildTelemetryRoutes(deps: TelemetryRoutesDeps) {
  const app = new Hono<Vars>();

  // POST /events — public ingest.
  app.post("/events", async (c) => {
    if (deps.rateLimit) {
      const limited = await deps.rateLimit(c);
      if (limited) {
        return c.json(
          { error: { type: "rate_limit_error", message: "Too many telemetry events." } },
          429,
        );
      }
    }

    const raw = await c.req.json().catch(() => null);
    const parsed = commandEventSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            type: "invalid_request_error",
            message: parsed.error.issues[0]?.message ?? "Invalid telemetry event.",
          },
        },
        400,
      );
    }
    const body = parsed.data;

    try {
      const services = resolveServices(deps.services, c);
      await services.sql
        .prepare(
          `INSERT INTO telemetry_events
             (id, event, command, cli_version, os, arch, node_version, machine_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          genId(),
          body.event,
          body.command,
          body.cli_version,
          body.os,
          body.arch,
          body.node_version ?? null,
          body.machine_id,
          Date.now(),
        )
        .run();
    } catch (err) {
      // Fire-and-forget: never break the CLI over a telemetry write failure.
      console.warn("[telemetry] failed to record event", err);
    }

    return c.json({ ok: true }, 202);
  });

  // POST /ingest — public server-side install / deployment phone-home.
  // Same fire-and-forget contract as /events: only rate-limiting (429) and
  // schema validation (400) produce a non-202 response; an insert failure is
  // swallowed so a reporting install is never broken by our storage.
  app.post("/ingest", async (c) => {
    if (deps.rateLimit) {
      const limited = await deps.rateLimit(c);
      if (limited) {
        return c.json(
          { error: { type: "rate_limit_error", message: "Too many telemetry reports." } },
          429,
        );
      }
    }

    const raw = await c.req.json().catch(() => null);
    const parsed = installReportSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            type: "invalid_request_error",
            message: parsed.error.issues[0]?.message ?? "Invalid telemetry report.",
          },
        },
        400,
      );
    }
    const body = parsed.data;

    try {
      const services = resolveServices(deps.services, c);
      await services.sql
        .prepare(
          `INSERT INTO telemetry_installs
             (id, instance_id, oma_version, deployment_kind, agents_total, agents_active,
              sessions_total, sessions_running, session_duration_total_ms,
              session_duration_avg_ms, idle_time_total_ms, sandbox_launches, model_ids,
              created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          genId(),
          body.instance_id,
          body.oma_version ?? null,
          body.deployment_kind,
          body.agents_total,
          body.agents_active,
          body.sessions_total,
          body.sessions_running,
          body.session_duration_total_ms,
          body.session_duration_avg_ms,
          body.idle_time_total_ms,
          body.sandbox_launches ? JSON.stringify(body.sandbox_launches) : null,
          body.model_ids ? JSON.stringify(body.model_ids) : null,
          Date.now(),
        )
        .run();
    } catch (err) {
      // Fire-and-forget: never break the reporter over a telemetry write.
      console.warn("[telemetry] failed to record install report", err);
    }

    return c.json({ ok: true }, 202);
  });

  // GET /stats — public, global (not tenant-scoped) aggregate counts.
  app.get("/stats", async (c) => {
    const services = resolveServices(deps.services, c);
    const sql = services.sql;

    const safeFirst = async <T,>(query: string, fallback: T): Promise<T> => {
      try {
        const row = await sql.prepare(query).first<T>();
        return row ?? fallback;
      } catch (err) {
        console.warn("[telemetry] stats query failed", err);
        return fallback;
      }
    };
    const safeAll = async <T,>(query: string): Promise<T[]> => {
      try {
        const res = await sql.prepare(query).all<T>();
        return res.results ?? [];
      } catch (err) {
        console.warn("[telemetry] stats query failed", err);
        return [];
      }
    };

    const agentsTotal = await safeFirst<{ n: number }>(
      `SELECT COUNT(*) AS n FROM agents`,
      { n: 0 },
    );
    const agentsActive = await safeFirst<{ n: number }>(
      `SELECT COUNT(*) AS n FROM agents WHERE archived_at IS NULL`,
      { n: 0 },
    );
    const sessionsTotal = await safeFirst<{ n: number }>(
      `SELECT COUNT(*) AS n FROM sessions`,
      { n: 0 },
    );
    const sessionsRunning = await safeFirst<{ n: number }>(
      `SELECT COUNT(*) AS n FROM sessions WHERE status = 'running'`,
      { n: 0 },
    );
    // "Tasks" = recurring work configured on the platform: deployments +
    // agent schedules (there is no dedicated tasks table).
    const deploymentsTotal = await safeFirst<{ n: number }>(
      `SELECT COUNT(*) AS n FROM deployments`,
      { n: 0 },
    );
    const schedulesTotal = await safeFirst<{ n: number }>(
      `SELECT COUNT(*) AS n FROM agent_schedules`,
      { n: 0 },
    );
    const totalCommands = await safeFirst<{ n: number }>(
      `SELECT COUNT(*) AS n FROM telemetry_events WHERE event = 'command'`,
      { n: 0 },
    );
    const byCommand = await safeAll<{ name: string; count: number }>(
      `SELECT command AS name, COUNT(*) AS count FROM telemetry_events
        WHERE event = 'command' GROUP BY command ORDER BY count DESC LIMIT 20`,
    );
    const byPlatform = await safeAll<{ platform: string; count: number }>(
      `SELECT os AS platform, COUNT(*) AS count FROM telemetry_events
        WHERE event = 'command' GROUP BY os ORDER BY count DESC`,
    );

    // ── Install / deployment phone-home aggregates ──────────────────────
    // Only the LATEST report per instance_id counts (an install re-reports
    // every ~6h; we want its current state, not a running total). The
    // per-instance latest rows are fetched once and the JSON columns
    // (sandbox_launches, model_ids) are merged in JS — simplest + safe.
    interface InstallRow {
      instance_id: string;
      oma_version: string | null;
      deployment_kind: string | null;
      sessions_total: number | null;
      session_duration_avg_ms: number | null;
      sandbox_launches: string | null;
      model_ids: string | null;
      created_at: number;
    }
    const latestInstallRows = await safeAll<InstallRow>(
      `SELECT t.instance_id, t.oma_version, t.deployment_kind, t.sessions_total,
              t.session_duration_avg_ms, t.sandbox_launches, t.model_ids, t.created_at
         FROM telemetry_installs t
         JOIN (
           SELECT instance_id, MAX(created_at) AS mc
             FROM telemetry_installs GROUP BY instance_id
         ) m ON t.instance_id = m.instance_id AND t.created_at = m.mc`,
    );
    // Dedupe by instance_id — guards the created_at-tie edge (two rows for one
    // instance sharing the same MAX(created_at) would otherwise double-count).
    const latestByInstance = new Map<string, InstallRow>();
    for (const row of latestInstallRows) {
      if (!latestByInstance.has(row.instance_id)) latestByInstance.set(row.instance_id, row);
    }
    const installRows = [...latestByInstance.values()];

    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    let installsActive = 0;
    let sessionsReported = 0;
    let durationSum = 0;
    let durationCount = 0;
    const kindCounts = new Map<string, number>();
    const sandboxCounts = new Map<string, number>();
    const modelCounts = new Map<string, number>();
    const versionCounts = new Map<string, number>();

    for (const row of installRows) {
      if (row.created_at >= sevenDaysAgo) installsActive += 1;
      sessionsReported += Number(row.sessions_total ?? 0) || 0;
      if (row.session_duration_avg_ms != null) {
        durationSum += Number(row.session_duration_avg_ms) || 0;
        durationCount += 1;
      }
      const kind = row.deployment_kind ?? "unknown";
      kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
      if (row.oma_version) {
        versionCounts.set(row.oma_version, (versionCounts.get(row.oma_version) ?? 0) + 1);
      }
      if (row.sandbox_launches) {
        try {
          const parsed = JSON.parse(row.sandbox_launches) as Record<string, number>;
          for (const [k, v] of Object.entries(parsed)) {
            const n = Number(v);
            if (Number.isFinite(n)) sandboxCounts.set(k, (sandboxCounts.get(k) ?? 0) + n);
          }
        } catch {
          /* skip malformed row */
        }
      }
      if (row.model_ids) {
        try {
          const ids = JSON.parse(row.model_ids) as unknown;
          if (Array.isArray(ids)) {
            // One count per instance per distinct model id.
            for (const id of new Set(ids.filter((x): x is string => typeof x === "string"))) {
              modelCounts.set(id, (modelCounts.get(id) ?? 0) + 1);
            }
          }
        } catch {
          /* skip malformed row */
        }
      }
    }

    const sortDesc = (m: Map<string, number>) =>
      [...m.entries()].sort((a, b) => b[1] - a[1]);

    return c.json({
      agents: { total: agentsTotal.n, active: agentsActive.n },
      sessions: { total: sessionsTotal.n, running: sessionsRunning.n },
      tasks: { total: deploymentsTotal.n + schedulesTotal.n, deployments: deploymentsTotal.n, schedules: schedulesTotal.n },
      cli: {
        total_commands: totalCommands.n,
        by_command: byCommand,
        by_platform: byPlatform,
      },
      installs: {
        total: installRows.length,
        active: installsActive,
        sessions_reported: sessionsReported,
        session_duration_avg_ms:
          durationCount > 0 ? Math.round(durationSum / durationCount) : 0,
        by_deployment_kind: sortDesc(kindCounts).map(([kind, count]) => ({ kind, count })),
        sandbox_launches: sortDesc(sandboxCounts).map(([kind, count]) => ({ kind, count })),
        model_mix: sortDesc(modelCounts)
          .slice(0, 20)
          .map(([name, count]) => ({ name, count })),
        versions: sortDesc(versionCounts).map(([version, count]) => ({ version, count })),
      },
      generated_at: Date.now(),
    });
  });

  return app;
}
