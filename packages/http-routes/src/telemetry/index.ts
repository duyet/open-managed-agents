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
      { n: agentsTotal.n },
    );
    const sessionsTotal = await safeFirst<{ n: number }>(
      `SELECT COUNT(*) AS n FROM sessions`,
      { n: 0 },
    );
    const sessionsRunning = await safeFirst<{ n: number }>(
      `SELECT COUNT(*) AS n FROM sessions WHERE status = 'running'`,
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

    return c.json({
      agents: { total: agentsTotal.n, active: agentsActive.n },
      sessions: { total: sessionsTotal.n, running: sessionsRunning.n },
      tasks: { total: 0 },
      cli: {
        total_commands: totalCommands.n,
        by_command: byCommand,
        by_platform: byPlatform,
      },
      generated_at: Date.now(),
    });
  });

  return app;
}
