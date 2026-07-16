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

import { Hono } from "hono";
import type { Env } from "@duyet/oma-shared";
import type { Services } from "@duyet/oma-services";

const app = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; services: Services; tenantDb: D1Database };
}>();

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
  /** Resolved via json_extract on agents.config (agents have no `name`
   *  column — same idiom as sql-agent-repo.ts's name search). Null when
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

app.get("/", async (c) => {
  const tenantDb = c.get("tenantDb");
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

  const [totalActiveRow, byKindRows, byInstanceRows, dailyRows, sessionCountRow] =
    await Promise.all([
      // Total sandbox active seconds
      tenantDb
        .prepare(
          `SELECT COALESCE(SUM(value), 0) AS total
             FROM usage_events
            WHERE tenant_id = ? AND kind = 'sandbox_active_seconds' AND created_at >= ?`,
        )
        .bind(tenantId, sinceMs)
        .first<{ total: number }>(),

      // Breakdown by kind
      tenantDb
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
      tenantDb
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

      // Daily buckets across the requested window
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
        .bind(tenantId, sinceMs)
        .all<DailyBucket>(),

      // Total distinct sessions that have usage events
      tenantDb
        .prepare(
          `SELECT COUNT(DISTINCT session_id) AS count
             FROM usage_events
            WHERE tenant_id = ? AND created_at >= ?`,
        )
        .bind(tenantId, sinceMs)
        .first<{ count: number }>(),
    ]);

  let byAgent: UsageByAgent[] | undefined;
  if (groupByAgent) {
    const [agentTotalsRows, agentKindRows] = await Promise.all([
      // agent_name resolves via json_extract on the JSON config blob (agents
      // has no `name` column — same idiom as sql-agent-repo.ts's name
      // search). GROUP BY ue.agent_id with a non-aggregated agent_name
      // column is safe here: it's functionally dependent on agent_id via
      // the join, so every row within a group shares the same value.
      tenantDb
        .prepare(
          `SELECT ue.agent_id AS agent_id,
                  json_extract(a.config, '$.name') AS agent_name,
                  COALESCE(SUM(CASE WHEN ue.kind = 'sandbox_active_seconds' THEN ue.value ELSE 0 END), 0) AS total_active_seconds,
                  COUNT(DISTINCT ue.session_id) AS total_sessions
             FROM usage_events ue
             LEFT JOIN agents a ON a.id = ue.agent_id AND a.tenant_id = ue.tenant_id
            WHERE ue.tenant_id = ? AND ue.created_at >= ?
            GROUP BY ue.agent_id
            ORDER BY total_active_seconds DESC`,
        )
        .bind(tenantId, sinceMs)
        .all<{
          agent_id: string | null;
          agent_name: string | null;
          total_active_seconds: number;
          total_sessions: number;
        }>(),

      tenantDb
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

    byAgent = (agentTotalsRows.results ?? []).map((row) => ({
      agent_id: row.agent_id,
      agent_name: row.agent_name,
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
    daily: dailyRows.results ?? [],
    ...(byAgent ? { by_agent: byAgent } : {}),
  };

  return c.json(body);
});

export default app;
