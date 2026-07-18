// @ts-nocheck
// GET /v1/agents/:id/stats — per-agent usage analytics (sessions, tokens,
// sandbox seconds, cost estimates). Aggregates the sessions table plus the
// usage_events kinds model_input_tokens / model_output_tokens /
// sandbox_active_seconds, tenant- and agent-scoped.
import { env, exports } from "cloudflare:workers";
import { describe, it, expect } from "vitest";

const HEADERS = {
  "x-api-key": "test-key",
  "Content-Type": "application/json",
};

// authMiddleware maps the test API key to tenant "default".
const TENANT = "default";

function api(path: string, init?: RequestInit) {
  return exports.default.fetch(new Request(`http://localhost${path}`, init));
}

async function createAgent(name = "Stats Agent") {
  const res = await api("/v1/agents", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      name,
      model: "claude-sonnet-4-6",
      system: "You are helpful.",
      tools: [{ type: "agent_toolset_20260401" }],
      harness: "test",
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as any;
}

function db(): D1Database {
  return (env as { AUTH_DB: D1Database }).AUTH_DB;
}

async function seedUsage(agentId: string, sessionId: string, kind: string, value: number) {
  await db()
    .prepare(
      `INSERT INTO usage_events (tenant_id, session_id, agent_id, kind, value, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(TENANT, sessionId, agentId, kind, value, Date.now())
    .run();
}

describe("GET /v1/agents/:id/stats", () => {
  it("404s for an unknown agent", async () => {
    const res = await api("/v1/agents/agent_does_not_exist/stats", { headers: HEADERS });
    expect(res.status).toBe(404);
  });

  it("returns zeroes for an agent with no sessions or usage", async () => {
    const agent = await createAgent("Fresh Agent");
    const res = await api(`/v1/agents/${agent.id}/stats`, { headers: HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({
      agent_id: agent.id,
      sessions: 0,
      input_tokens: 0,
      output_tokens: 0,
      sandbox_seconds: 0,
      est_model_cost_usd: 0,
      est_sandbox_cost_usd: 0,
    });
    expect(body.assumptions.model_usd_per_mtok_in).toBeGreaterThan(0);
  });

  it("aggregates sessions, tokens, and sandbox seconds scoped to the agent", async () => {
    const agent = await createAgent("Busy Agent");
    const other = await createAgent("Other Agent");

    // Two sessions for the target agent, one for the other agent.
    // Ready environment (simulates build-complete, same as test/helpers.ts
    // but through this file's `exports.default`-based fetch).
    const envRes = await api("/v1/environments", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ name: "stats-env", config: { type: "cloud" } }),
    });
    const environment = (await envRes.json()) as any;
    await env.CONFIG_KV.put(
      `env:${environment.id}`,
      JSON.stringify({ ...environment, status: "ready", sandbox_worker_name: "test-local" }),
    );
    for (const a of [agent, agent, other]) {
      const res = await api("/v1/sessions", {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ agent: a.id, environment_id: environment.id }),
      });
      expect(res.status).toBe(201);
    }

    // Token + sandbox usage rows — the other agent's rows must not leak in.
    await seedUsage(agent.id, "sess_stats_1", "model_input_tokens", 120_000);
    await seedUsage(agent.id, "sess_stats_1", "model_output_tokens", 4_000);
    await seedUsage(agent.id, "sess_stats_1", "model_cache_read_tokens", 60_000);
    await seedUsage(agent.id, "sess_stats_1", "model_cache_creation_tokens", 10_000);
    await seedUsage(agent.id, "sess_stats_1", "model_reasoning_tokens", 2_500);
    await seedUsage(agent.id, "sess_stats_2", "model_input_tokens", 80_000);
    await seedUsage(agent.id, "sess_stats_2", "sandbox_active_seconds", 3600);
    await seedUsage(other.id, "sess_stats_3", "model_input_tokens", 999_999);

    const res = await api(`/v1/agents/${agent.id}/stats`, { headers: HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.sessions).toBe(2);
    expect(body.input_tokens).toBe(200_000);
    expect(body.output_tokens).toBe(4_000);
    expect(body.cache_read_tokens).toBe(60_000);
    expect(body.cache_creation_tokens).toBe(10_000);
    expect(body.reasoning_tokens).toBe(2_500);
    // cache_read / (cache_read + input) = 60_000 / 260_000
    expect(body.cache_hit_ratio).toBeCloseTo(60_000 / 260_000, 6);
    expect(body.sandbox_seconds).toBe(3600);
    // 0.2 Mtok in × $3 + 0.004 Mtok out × $15 = 0.6 + 0.06
    expect(body.est_model_cost_usd).toBeCloseTo(0.66, 5);
    // 1h × $0.02
    expect(body.est_sandbox_cost_usd).toBeCloseTo(0.02, 5);
  });
});
