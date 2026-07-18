// /v1/stats — aggregate counts for the dashboard headline.
//
// Replaces the legacy "fetch /v1/agents?limit=1000 then read .data.length"
// pattern in console/Dashboard.tsx, which pulled every row across seven
// resources just to render seven numbers. Each store's count() runs as a
// covering-index COUNT(*) (idx_<table>_tenant); skills/api_keys are KV
// list-length lookups.
//
// All counts are scoped to the active tenant, exclude archived rows where
// the resource has that concept (agents/sessions/environments/vaults), and
// include only the items the dashboard headline cards represent.
//
// Ported from apps/main/src/routes/stats.ts (CF-local) — the two usage_events
// aggregates (COALESCE(SUM), COUNT(DISTINCT session_id)) are plain SQL with
// no dialect-specific functions, so they run unchanged against `services.sql`
// on both D1 (CF) and Postgres/SQLite (self-host Node).

import { Hono } from "hono";
import { listAll as kvListAll } from "@duyet/oma-kv-store";
import type { RouteServicesArg } from "../types";
import { resolveServices } from "../types";

interface Vars {
  Variables: { tenant_id: string };
}

export interface StatsRoutesDeps {
  services: RouteServicesArg;
}

interface StatsResponse {
  agents: number;
  sessions: number;
  environments: number;
  vaults: number;
  skills: number;
  model_cards: number;
  api_keys: number;
  total_sandbox_seconds: number;
  total_usage_sessions: number;
}

const kvPrefix = (tenantId: string, ...parts: string[]) => `t:${tenantId}:${parts.join(":")}:`;

export function buildStatsRoutes(deps: StatsRoutesDeps) {
  const app = new Hono<Vars>();

  app.get("/", async (c) => {
    const services = resolveServices(deps.services, c);
    const tenantId = c.get("tenant_id");

    const [
      agents,
      sessions,
      environments,
      vaults,
      skillKeys,
      modelCards,
      apiKeyIndex,
      sandboxSecondsRow,
      usageSessionsRow,
    ] = await Promise.all([
      services.agents.count({ tenantId }),
      services.sessions.count({ tenantId }),
      services.environments ? services.environments.count({ tenantId }) : Promise.resolve(0),
      services.vaults.count({ tenantId }),
      // Skills + api_keys live in KV; counts are key-scan / index-length, both
      // cheap relative to the old "fetch every row + .length" approach.
      kvListAll(services.kv, kvPrefix(tenantId, "skill")),
      services.modelCards ? services.modelCards.list({ tenantId }) : Promise.resolve([]),
      services.kv.get(`t:${tenantId}:apikeys`),
      // Usage aggregates
      services.sql
        .prepare(
          `SELECT COALESCE(SUM(value), 0) AS total
             FROM usage_events
            WHERE tenant_id = ? AND kind = 'sandbox_active_seconds'`,
        )
        .bind(tenantId)
        .first<{ total: number }>(),
      services.sql
        .prepare(
          `SELECT COUNT(DISTINCT session_id) AS count
             FROM usage_events
            WHERE tenant_id = ?`,
        )
        .bind(tenantId)
        .first<{ count: number }>(),
    ]);

    const apiKeysList = apiKeyIndex
      ? (JSON.parse(apiKeyIndex) as Array<{ id: string }>)
      : [];

    const body: StatsResponse = {
      agents,
      sessions,
      environments,
      vaults,
      skills: skillKeys.length,
      model_cards: modelCards.filter((card) => card.archived_at === null).length,
      api_keys: apiKeysList.length,
      total_sandbox_seconds: sandboxSecondsRow?.total ?? 0,
      total_usage_sessions: usageSessionsRow?.count ?? 0,
    };
    return c.json(body);
  });

  return app;
}
