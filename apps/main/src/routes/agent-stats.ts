// GET /v1/agents/:agentId/stats — per-agent usage analytics for the
// Console's agent detail page.
//
// Aggregates from control-plane tables only (no DO event-log replay):
//   - sessions:      COUNT(*) over the sessions table (all-time, incl.
//                    archived — "how much has this agent been used").
//   - tokens:        SUM(value) over usage_events kinds model_input_tokens /
//                    model_output_tokens / model_cache_read_tokens /
//                    model_cache_creation_tokens / model_reasoning_tokens,
//                    populated by SessionDO's usage-credit hooks per
//                    completed turn (input/output via reportUsage; cache +
//                    reasoning via span/aux inspection). Sessions that ran
//                    before a kind existed simply don't contribute — counts
//                    accrue going forward. cache_hit_ratio = cache_read /
//                    (cache_read + input).
//   - sandbox:       SUM(value) over kind = sandbox_active_seconds.
//
// Cost estimates are intentionally rough and the assumed rates are echoed
// back in the response so the UI can label them honestly. Rates are NOT
// per-model (usage_events doesn't record the model id) — we assume
// Sonnet-class pricing for tokens and a flat sandbox rate.

import { Hono } from "hono";
import type { Env } from "@duyet/oma-shared";
import type { Services } from "@duyet/oma-services";

const app = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; services: Services; tenantDb: D1Database };
}>();

/** Assumed pricing for the estimates below. Documented, not configurable
 *  (yet) — the response echoes these so clients can display/override. */
const MODEL_USD_PER_MTOK_IN = 3; // Sonnet-class input rate
const MODEL_USD_PER_MTOK_OUT = 15; // Sonnet-class output rate
const SANDBOX_USD_PER_HOUR = 0.02; // flat container-hour estimate

export interface AgentStatsResponse {
  agent_id: string;
  sessions: number;
  input_tokens: number;
  output_tokens: number;
  /** Full model-token breakdown. cache_read/creation and reasoning accrue
   *  from their own usage_events kinds; sessions predating those kinds
   *  simply contribute 0. */
  cache_read_tokens: number;
  cache_creation_tokens: number;
  reasoning_tokens: number;
  /** cache_read / (cache_read + input), 0 when the denominator is 0 —
   *  how much of the input context was served from prompt cache. */
  cache_hit_ratio: number;
  sandbox_seconds: number;
  est_model_cost_usd: number;
  est_sandbox_cost_usd: number;
  assumptions: {
    model_usd_per_mtok_in: number;
    model_usd_per_mtok_out: number;
    sandbox_usd_per_hour: number;
  };
}

app.get("/:agentId/stats", async (c) => {
  const tenantId = c.get("tenant_id");
  const agentId = c.req.param("agentId");
  const services = c.var.services;
  const tenantDb = c.get("tenantDb");

  const agent = await services.agents.get({ tenantId, agentId });
  if (!agent) return c.json({ error: "Agent not found" }, 404);

  const [sessionRow, tokenRows, sandboxRow] = await Promise.all([
    tenantDb
      .prepare(
        `SELECT COUNT(*) AS count FROM sessions
          WHERE tenant_id = ? AND agent_id = ?`,
      )
      .bind(tenantId, agentId)
      .first<{ count: number }>(),
    tenantDb
      .prepare(
        `SELECT kind, COALESCE(SUM(value), 0) AS total
           FROM usage_events
          WHERE tenant_id = ? AND agent_id = ?
            AND kind IN ('model_input_tokens', 'model_output_tokens',
                         'model_cache_read_tokens', 'model_cache_creation_tokens',
                         'model_reasoning_tokens')
          GROUP BY kind`,
      )
      .bind(tenantId, agentId)
      .all<{ kind: string; total: number }>(),
    tenantDb
      .prepare(
        `SELECT COALESCE(SUM(value), 0) AS total
           FROM usage_events
          WHERE tenant_id = ? AND agent_id = ?
            AND kind = 'sandbox_active_seconds'`,
      )
      .bind(tenantId, agentId)
      .first<{ total: number }>(),
  ]);

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let reasoningTokens = 0;
  for (const r of tokenRows.results ?? []) {
    if (r.kind === "model_input_tokens") inputTokens = r.total;
    else if (r.kind === "model_output_tokens") outputTokens = r.total;
    else if (r.kind === "model_cache_read_tokens") cacheReadTokens = r.total;
    else if (r.kind === "model_cache_creation_tokens") cacheCreationTokens = r.total;
    else if (r.kind === "model_reasoning_tokens") reasoningTokens = r.total;
  }
  const sandboxSeconds = sandboxRow?.total ?? 0;
  const cacheDenom = cacheReadTokens + inputTokens;
  const cacheHitRatio = cacheDenom > 0 ? cacheReadTokens / cacheDenom : 0;

  const body: AgentStatsResponse = {
    agent_id: agentId,
    sessions: sessionRow?.count ?? 0,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_tokens: cacheReadTokens,
    cache_creation_tokens: cacheCreationTokens,
    reasoning_tokens: reasoningTokens,
    cache_hit_ratio: cacheHitRatio,
    sandbox_seconds: sandboxSeconds,
    est_model_cost_usd:
      (inputTokens / 1_000_000) * MODEL_USD_PER_MTOK_IN +
      (outputTokens / 1_000_000) * MODEL_USD_PER_MTOK_OUT,
    est_sandbox_cost_usd: (sandboxSeconds / 3600) * SANDBOX_USD_PER_HOUR,
    assumptions: {
      model_usd_per_mtok_in: MODEL_USD_PER_MTOK_IN,
      model_usd_per_mtok_out: MODEL_USD_PER_MTOK_OUT,
      sandbox_usd_per_hour: SANDBOX_USD_PER_HOUR,
    },
  };
  return c.json(body);
});

export default app;
