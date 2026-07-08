// /v1/usage — aggregated resource usage for the dashboard analytics section.
//
// Returns per-kind totals, per-instance-type breakdown, daily time-series
// buckets, and total session count. All scoped to the active tenant.
//
// The raw data comes from usage_events (populated by sandbox/browser/session
// lifecycle hooks). No pricing/credits calculation here — just seconds.

import { Hono } from "hono";
import type { Env } from "@duyet/oma-shared";
import type { Services } from "@duyet/oma-services";

const app = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; services: Services; tenantDb: D1Database };
}>();

export interface UsageByKind {
  kind: string;
  total_seconds: number;
}

export interface UsageByInstanceType {
  instance_type: string | null;
  total_seconds: number;
}

export interface DailyBucket {
  date: string;       // YYYY-MM-DD
  active_seconds: number;
  runs: number;       // distinct session_id count
}

export interface UsageSummary {
  total_active_seconds: number;
  total_sessions: number;
  by_kind: UsageByKind[];
  by_instance_type: UsageByInstanceType[];
  daily: DailyBucket[];
}

app.get("/", async (c) => {
  const tenantDb = c.get("tenantDb");
  const tenantId = c.get("tenant_id");

  const [totalActiveRow, byKindRows, byInstanceRows, dailyRows, sessionCountRow] =
    await Promise.all([
      // Total sandbox active seconds
      tenantDb
        .prepare(
          `SELECT COALESCE(SUM(value), 0) AS total
             FROM usage_events
            WHERE tenant_id = ? AND kind = 'sandbox_active_seconds'`,
        )
        .bind(tenantId)
        .first<{ total: number }>(),

      // Breakdown by kind
      tenantDb
        .prepare(
          `SELECT kind, COALESCE(SUM(value), 0) AS total_seconds
             FROM usage_events
            WHERE tenant_id = ?
            GROUP BY kind
            ORDER BY total_seconds DESC`,
        )
        .bind(tenantId)
        .all<UsageByKind>(),

      // Breakdown by instance_type (sandbox only)
      tenantDb
        .prepare(
          `SELECT COALESCE(instance_type, 'unknown') AS instance_type,
                  COALESCE(SUM(value), 0) AS total_seconds
             FROM usage_events
            WHERE tenant_id = ? AND kind = 'sandbox_active_seconds'
            GROUP BY instance_type
            ORDER BY total_seconds DESC`,
        )
        .bind(tenantId)
        .all<UsageByInstanceType>(),

      // Daily buckets for the last 30 days
      tenantDb
        .prepare(
          `SELECT DATE(created_at / 1000, 'unixepoch') AS date,
                  COALESCE(SUM(value), 0) AS active_seconds,
                  COUNT(DISTINCT session_id) AS runs
             FROM usage_events
            WHERE tenant_id = ?
              AND kind = 'sandbox_active_seconds'
              AND created_at >= ?
            GROUP BY DATE(created_at / 1000, 'unixepoch')
            ORDER BY date ASC`,
        )
        .bind(tenantId, Date.now() - 30 * 24 * 3600 * 1000)
        .all<DailyBucket>(),

      // Total distinct sessions that have usage events
      tenantDb
        .prepare(
          `SELECT COUNT(DISTINCT session_id) AS count
             FROM usage_events
            WHERE tenant_id = ?`,
        )
        .bind(tenantId)
        .first<{ count: number }>(),
    ]);

  const body: UsageSummary = {
    total_active_seconds: totalActiveRow?.total ?? 0,
    total_sessions: sessionCountRow?.count ?? 0,
    by_kind: byKindRows.results ?? [],
    by_instance_type: byInstanceRows.results ?? [],
    daily: dailyRows.results ?? [],
  };

  return c.json(body);
});

export default app;
