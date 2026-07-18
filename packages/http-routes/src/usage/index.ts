// /v1/usage — aggregated resource usage for the dashboard analytics section.
//
// Returns per-kind totals, per-instance-type breakdown, daily time-series
// buckets, and total session count, scoped to a `?days=` window (1-90,
// default 30; 0 = all-time — no lower bound on created_at). Optionally
// grouped by agent via `?group_by=agent`. All scoped to the active tenant.
//
// The raw data comes from usage_events (populated by sandbox/browser/session
// lifecycle hooks). No pricing/credits calculation here — just seconds and
// tokens (issue #231 point 4: a blended $ total stays out of scope — token
// and sandbox rates today only exist per-agent, hardcoded, in
// agent-stats.ts; there's no tenant-wide pricing model to blend against).
//
// Ported from apps/main/src/routes/usage.ts (CF-local, D1-only). Two of the
// original queries used SQLite/D1-only SQL that breaks on Postgres:
//   - `daily`: used `DATE(created_at/1000,'unixepoch')` bucketing in SQL.
//     Rewritten to fetch raw (created_at, value, session_id) rows and bucket
//     by UTC day in JS.
//   - `by_agent`: used `json_extract(a.config,'$.name')` to resolve
//     agent_name in SQL. Rewritten to a portable GROUP BY ue.agent_id, then
//     resolve agent_name in JS via services.agents.get() per agent_id.
// Every other aggregate (totals, by_kind, by_instance_type, session count,
// by_agent kind breakdown) was already plain SUM/COUNT/GROUP BY — portable
// as-is against `services.sql` on both D1 and Postgres/SQLite.

import { Hono } from "hono";
import type { RouteServicesArg } from "../types";
import { resolveServices } from "../types";

interface Vars {
  Variables: { tenant_id: string };
}

export interface UsageRoutesDeps {
  services: RouteServicesArg;
}

export interface UsageByKind {
  kind: string;
  /** Seconds for the sandbox/browser/session kinds, raw token count for
   *  model_input_tokens/model_output_tokens (see the Console page's
   *  KIND_META for the per-kind unit). Named `total`, not `total_seconds`
   *  (#231) — the old name lied about the unit for the token kinds. */
  total: number;
}

export interface UsageByInstanceType {
  instance_type: string | null;
  /** Always genuinely seconds — this breakdown only ever covers the
   *  sandbox_active_seconds kind, so no renaming needed here. */
  total_seconds: number;
}

export interface DailyBucket {
  date: string;       // YYYY-MM-DD
  active_seconds: number;
  runs: number;       // distinct session_id count
}

export interface UsageByAgent {
  /** Null = usage_events rows with no agent_id (not attributed to any
   *  agent) — surfaced as its own bucket rather than dropped, so by_agent
   *  totals can be reconciled against the tenant-wide totals above. */
  agent_id: string | null;
  /** Resolved via services.agents.get() (agent config's `name`). Null when
   *  agent_id is null, or the agent row can't be found. */
  agent_name: string | null;
  total_active_seconds: number;
  total_sessions: number;
  by_kind: UsageByKind[];
}

export interface UsagePeriod {
  /** The window actually applied, after clamping: 1-90, or 0 for all-time. */
  days: number;
  /** ISO-8601 lower bound on created_at; null when days=0 (all-time). */
  since: string | null;
}

export interface UsageSummary {
  period: UsagePeriod;
  total_active_seconds: number;
  total_sessions: number;
  by_kind: UsageByKind[];
  by_instance_type: UsageByInstanceType[];
  daily: DailyBucket[];
  /** Only present when `?group_by=agent` was requested — opt-in since it
   *  costs two extra queries. */
  by_agent?: UsageByAgent[];
}

export function buildUsageRoutes(deps: UsageRoutesDeps) {
  const app = new Hono<Vars>();

  app.get("/", async (c) => {
    const services = resolveServices(deps.services, c);
    const sql = services.sql;
    const tenantId = c.get("tenant_id");

    // days: 1-90 range clamp, 0 = all-time (no lower bound on created_at).
    // Mirrors /v1/cost_report's ?days= convention (#231) but adds 0-as-all-time
    // since usage_events — unlike the Cloudflare billing API cost-report
    // reads from — can actually answer an unbounded query. Unlike
    // cost-report.ts's silent `parseInt(...) || 30` fallback, an unparseable
    // value here is a 400, not a silent default: matches the stricter
    // enum/timestamp precedent in environments.ts/model-cards.ts (masking a
    // typo'd days value as "30" would hide a client bug, not fix one).
    const daysRaw = c.req.query("days");
    let days = 30;
    if (daysRaw !== undefined) {
      if (!/^\d+$/.test(daysRaw)) {
        return c.json(
          {
            error: {
              type: "invalid_request_error",
              code: "invalid_days",
              message: `Invalid days '${daysRaw}'; expected a non-negative integer (0 = all-time, max 90).`,
            },
          },
          400,
        );
      }
      days = Math.min(90, Number.parseInt(daysRaw, 10));
    }
    const sinceMs = days === 0 ? 0 : Date.now() - days * 24 * 3600 * 1000;

    // group_by: whitelist strictly (same rationale as the enum params above)
    // — "agent" is the only supported grouping today.
    const groupByRaw = c.req.query("group_by");
    let groupByAgent = false;
    if (groupByRaw !== undefined) {
      if (groupByRaw === "agent") {
        groupByAgent = true;
      } else {
        return c.json(
          {
            error: {
              type: "invalid_request_error",
              code: "invalid_group_by",
              message: `Invalid group_by '${groupByRaw}'; expected 'agent'.`,
            },
          },
          400,
        );
      }
    }

    const [totalActiveRow, byKindRows, byInstanceRows, dailyRawRows, sessionCountRow] =
      await Promise.all([
        // Total sandbox active seconds
        sql
          .prepare(
            `SELECT COALESCE(SUM(value), 0) AS total
               FROM usage_events
              WHERE tenant_id = ? AND kind = 'sandbox_active_seconds' AND created_at >= ?`,
          )
          .bind(tenantId, sinceMs)
          .first<{ total: number }>(),

        // Breakdown by kind
        sql
          .prepare(
            `SELECT kind, COALESCE(SUM(value), 0) AS total
               FROM usage_events
              WHERE tenant_id = ? AND created_at >= ?
              GROUP BY kind
              ORDER BY total DESC`,
          )
          .bind(tenantId, sinceMs)
          .all<UsageByKind>(),

        // Breakdown by instance_type (sandbox only)
        sql
          .prepare(
            `SELECT COALESCE(instance_type, 'unknown') AS instance_type,
                    COALESCE(SUM(value), 0) AS total_seconds
               FROM usage_events
              WHERE tenant_id = ? AND kind = 'sandbox_active_seconds' AND created_at >= ?
              GROUP BY instance_type
              ORDER BY total_seconds DESC`,
          )
          .bind(tenantId, sinceMs)
          .all<UsageByInstanceType>(),

        // Raw rows for daily bucketing — done in JS below (portable across
        // D1/SQLite/Postgres; DATE(created_at/1000,'unixepoch') is SQLite-only).
        sql
          .prepare(
            `SELECT created_at, value, session_id
               FROM usage_events
              WHERE tenant_id = ? AND kind = 'sandbox_active_seconds' AND created_at >= ?`,
          )
          .bind(tenantId, sinceMs)
          .all<{ created_at: number; value: number; session_id: string }>(),

        // Total distinct sessions that have usage events
        sql
          .prepare(
            `SELECT COUNT(DISTINCT session_id) AS count
               FROM usage_events
              WHERE tenant_id = ? AND created_at >= ?`,
          )
          .bind(tenantId, sinceMs)
          .first<{ count: number }>(),
      ]);

    const daily = bucketDaily(dailyRawRows.results ?? []);

    let byAgent: UsageByAgent[] | undefined;
    if (groupByAgent) {
      const [agentTotalsRows, agentKindRows] = await Promise.all([
        // Portable GROUP BY ue.agent_id (no json_extract — agent_name is
        // resolved separately below via services.agents.get()).
        sql
          .prepare(
            `SELECT agent_id,
                    COALESCE(SUM(CASE WHEN kind = 'sandbox_active_seconds' THEN value ELSE 0 END), 0) AS total_active_seconds,
                    COUNT(DISTINCT session_id) AS total_sessions
               FROM usage_events
              WHERE tenant_id = ? AND created_at >= ?
              GROUP BY agent_id
              ORDER BY total_active_seconds DESC`,
          )
          .bind(tenantId, sinceMs)
          .all<{
            agent_id: string | null;
            total_active_seconds: number;
            total_sessions: number;
          }>(),

        sql
          .prepare(
            `SELECT agent_id, kind, COALESCE(SUM(value), 0) AS total
               FROM usage_events
              WHERE tenant_id = ? AND created_at >= ?
              GROUP BY agent_id, kind
              ORDER BY agent_id, total DESC`,
          )
          .bind(tenantId, sinceMs)
          .all<{ agent_id: string | null; kind: string; total: number }>(),
      ]);

      const kindsByAgent = new Map<string | null, UsageByKind[]>();
      for (const row of agentKindRows.results ?? []) {
        const list = kindsByAgent.get(row.agent_id) ?? [];
        list.push({ kind: row.kind, total: row.total });
        kindsByAgent.set(row.agent_id, list);
      }

      const agentTotals = agentTotalsRows.results ?? [];
      const names = new Map<string, string | null>();
      await Promise.all(
        Array.from(new Set(agentTotals.map((r) => r.agent_id).filter((id): id is string => id !== null))).map(
          async (agentId) => {
            try {
              const agent = await services.agents.get({ tenantId, agentId });
              names.set(agentId, agent?.name ?? null);
            } catch {
              names.set(agentId, null);
            }
          },
        ),
      );

      byAgent = agentTotals.map((row) => ({
        agent_id: row.agent_id,
        agent_name: row.agent_id !== null ? (names.get(row.agent_id) ?? null) : null,
        total_active_seconds: row.total_active_seconds,
        total_sessions: row.total_sessions,
        by_kind: kindsByAgent.get(row.agent_id) ?? [],
      }));
    }

    const body: UsageSummary = {
      period: { days, since: days === 0 ? null : new Date(sinceMs).toISOString() },
      total_active_seconds: totalActiveRow?.total ?? 0,
      total_sessions: sessionCountRow?.count ?? 0,
      by_kind: byKindRows.results ?? [],
      by_instance_type: byInstanceRows.results ?? [],
      daily,
      ...(byAgent ? { by_agent: byAgent } : {}),
    };

    return c.json(body);
  });

  return app;
}

/** Bucket raw sandbox_active_seconds rows by UTC day, summing `value` and
 *  counting distinct session_id per day. Sorted ascending by date — same
 *  contract as the original `GROUP BY DATE(...) ORDER BY date ASC` query. */
function bucketDaily(
  rows: Array<{ created_at: number; value: number; session_id: string }>,
): DailyBucket[] {
  const buckets = new Map<string, { active_seconds: number; sessions: Set<string> }>();
  for (const row of rows) {
    const date = new Date(row.created_at).toISOString().slice(0, 10);
    const bucket = buckets.get(date) ?? { active_seconds: 0, sessions: new Set<string>() };
    bucket.active_seconds += row.value;
    bucket.sessions.add(row.session_id);
    buckets.set(date, bucket);
  }
  return Array.from(buckets.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, b]) => ({ date, active_seconds: b.active_seconds, runs: b.sessions.size }));
}
