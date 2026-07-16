// Route-level coverage for the Observability analytics endpoints:
//   GET /v1/analytics/overview      (buildAnalyticsRoutes)
//   GET /v1/agents/:id/analytics    (buildAgentRoutes)
//
// Seeds sessions with known token / stop_reason / created_at values through
// the in-memory SessionService and asserts the aggregates the Console will
// render. Deterministic via a ManualClock pinned to a fixed "now".

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  createInMemorySessionService,
  ManualClock,
  type InMemorySessionRepo,
} from "@duyet/oma-sessions-store/test-fakes";
import type { SessionService } from "@duyet/oma-sessions-store";
import { buildAnalyticsRoutes } from "./index";
import { buildAgentRoutes } from "../agents";
import type { RouteServices } from "../types";

const TENANT = "tenant-1";
const NOW = Date.UTC(2026, 6, 30, 12, 0, 0); // 2026-07-30T12:00:00Z
const DAY = 86_400_000;

async function seed(
  repo: InMemorySessionRepo,
  s: {
    id: string;
    createdAt: number;
    input?: number;
    output?: number;
    tool?: number;
    msg?: number;
    stop?: string | null;
    agentId?: string;
    tenantId?: string;
  },
) {
  const tenantId = s.tenantId ?? TENANT;
  await repo.insertWithResources(
    {
      id: s.id,
      tenantId,
      agentId: s.agentId ?? "agent_1",
      environmentId: "env_1",
      title: s.id,
      status: "idle",
      vaultIds: null,
      agentSnapshot: null,
      environmentSnapshot: null,
      metadata: null,
      createdAt: s.createdAt,
    },
    [],
  );
  await repo.update(tenantId, s.id, {
    inputTokens: s.input ?? 0,
    outputTokens: s.output ?? 0,
    toolCallCount: s.tool ?? 0,
    messageCount: s.msg ?? 0,
    stopReason: s.stop ?? null,
    updatedAt: s.createdAt,
  });
}

function overviewApp(service: SessionService) {
  const app = new Hono<{ Variables: { tenant_id: string } }>();
  app.use("*", async (c, next) => {
    c.set("tenant_id", TENANT);
    await next();
  });
  app.route(
    "/v1/analytics",
    buildAnalyticsRoutes({ services: { sessions: service } as unknown as RouteServices }),
  );
  return app;
}

function agentApp(service: SessionService, knownAgentIds: string[]) {
  const services = {
    sessions: service,
    agents: {
      get: async ({ agentId }: { agentId: string }) =>
        knownAgentIds.includes(agentId) ? { id: agentId } : null,
    },
  } as unknown as RouteServices;
  const app = new Hono<{ Variables: { tenant_id: string } }>();
  app.use("*", async (c, next) => {
    c.set("tenant_id", TENANT);
    await next();
  });
  app.route("/v1/agents", buildAgentRoutes({ services }));
  return app;
}

describe("GET /v1/analytics/overview", () => {
  it("aggregates totals, error rate, token percentiles, stop reasons", async () => {
    const { service, repo } = createInMemorySessionService({ clock: new ManualClock(NOW) });
    // 4 sessions in range with known token totals.
    await seed(repo, { id: "s1", createdAt: NOW - 1 * DAY, input: 100, output: 10, tool: 2, msg: 1, stop: "end_turn" });
    await seed(repo, { id: "s2", createdAt: NOW - 2 * DAY, input: 200, output: 20, tool: 3, msg: 2, stop: "end_turn" });
    await seed(repo, { id: "s3", createdAt: NOW - 3 * DAY, input: 300, output: 30, tool: 0, msg: 1, stop: "destroyed" });
    await seed(repo, { id: "s4", createdAt: NOW - 4 * DAY, input: 400, output: 40, tool: 5, msg: 3, stop: "terminated" });
    // Out-of-range (older than 30d) — must be excluded.
    await seed(repo, { id: "old", createdAt: NOW - 60 * DAY, input: 9999, output: 9999, stop: "end_turn" });

    const res = await overviewApp(service).request("/v1/analytics/overview");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    expect(body.range).toBe("30d");
    expect(body.total_sessions).toBe(4);
    expect(body.completed_sessions).toBe(4);
    // error_count = destroyed sessions (s3) → 1/4.
    expect(body.error_count).toBe(1);
    expect(body.error_rate).toBeCloseTo(0.25);
    expect(body.tokens.input).toBe(1000);
    expect(body.tokens.output).toBe(100);
    expect(body.tokens.total).toBe(1100);
    expect(body.total_tool_calls).toBe(10);
    expect(body.total_turns).toBe(7);
    // per-session total-token distribution [110,220,330,440]: p50 nearest-rank.
    expect(body.tokens.per_session.total.p50).toBe(220);
    expect(body.tokens.per_session.total.p95).toBe(440);
    // stop reasons: end_turn x2, destroyed x1, terminated x1.
    const stops = Object.fromEntries(
      (body.stop_reasons as Array<{ stop_reason: string; count: number }>).map((r) => [
        r.stop_reason,
        r.count,
      ]),
    );
    expect(stops).toEqual({ end_turn: 2, destroyed: 1, terminated: 1 });
    // tool_usage per-tool-name is not available cross-session.
    expect(body.tool_usage).toBeUndefined();
  });

  it("time series has one dense daily bucket per day in range with the right counts", async () => {
    const { service, repo } = createInMemorySessionService({ clock: new ManualClock(NOW) });
    await seed(repo, { id: "a", createdAt: NOW - 1 * DAY, stop: "end_turn" });
    await seed(repo, { id: "b", createdAt: NOW - 1 * DAY, stop: "end_turn" });
    const res = await overviewApp(service).request("/v1/analytics/overview?range=7d");
    const body = (await res.json()) as any;
    expect(body.range).toBe("7d");
    // 7d window → 8 daily buckets (start day .. today inclusive).
    expect(body.sessions_over_time.length).toBe(8);
    const yesterday = new Date(NOW - 1 * DAY).toISOString().slice(0, 10);
    const bucket = body.sessions_over_time.find(
      (b: { date: string; count: number }) => b.date === yesterday,
    );
    expect(bucket.count).toBe(2);
    // Total across buckets equals total sessions.
    const sum = (body.sessions_over_time as Array<{ count: number }>).reduce(
      (n, b) => n + b.count,
      0,
    );
    expect(sum).toBe(2);
  });

  it("empty tenant returns zeroed aggregates, not an error", async () => {
    const { service } = createInMemorySessionService({ clock: new ManualClock(NOW) });
    const res = await overviewApp(service).request("/v1/analytics/overview");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.total_sessions).toBe(0);
    expect(body.error_rate).toBe(0);
    expect(body.tokens.total).toBe(0);
  });

  it("rejects an unknown range with 400", async () => {
    const { service } = createInMemorySessionService({ clock: new ManualClock(NOW) });
    const res = await overviewApp(service).request("/v1/analytics/overview?range=1y");
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("invalid_range");
  });
});

describe("GET /v1/agents/:id/analytics", () => {
  it("scopes aggregates to the agent's sessions", async () => {
    const { service, repo } = createInMemorySessionService({ clock: new ManualClock(NOW) });
    await seed(repo, { id: "x1", createdAt: NOW - 1 * DAY, input: 100, output: 10, agentId: "agent_a", stop: "end_turn" });
    await seed(repo, { id: "x2", createdAt: NOW - 2 * DAY, input: 200, output: 20, agentId: "agent_a", stop: "destroyed" });
    await seed(repo, { id: "y1", createdAt: NOW - 1 * DAY, input: 999, output: 999, agentId: "agent_b", stop: "end_turn" });

    const res = await agentApp(service, ["agent_a", "agent_b"]).request(
      "/v1/agents/agent_a/analytics",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.total_sessions).toBe(2);
    expect(body.tokens.input).toBe(300);
    expect(body.error_count).toBe(1);
    expect(body.error_rate).toBeCloseTo(0.5);
  });

  it("404s for an unknown agent", async () => {
    const { service } = createInMemorySessionService({ clock: new ManualClock(NOW) });
    const res = await agentApp(service, []).request("/v1/agents/nope/analytics");
    expect(res.status).toBe(404);
  });

  it("rejects an unknown range with 400", async () => {
    const { service } = createInMemorySessionService({ clock: new ManualClock(NOW) });
    const res = await agentApp(service, ["agent_a"]).request(
      "/v1/agents/agent_a/analytics?range=nope",
    );
    expect(res.status).toBe(400);
  });
});
