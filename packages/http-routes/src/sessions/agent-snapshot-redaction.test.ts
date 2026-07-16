// Regression coverage for issue #196: GET /v1/sessions/:id embeds the
// session's agent (via snapshotToSessionAgent, built from agent_snapshot)
// and must redact mcp_servers[].authorization_token the same way the agents
// routes do — agent_snapshot carries the real token so the MCP proxy can
// resolve it, but it must never reach a client through this response.
// Uses a minimal services.sessions.get stub + SessionRouter stub, same
// pattern as pause-resume.test.ts — only GET /:id is exercised here.
//
// Also covers issue #223: GET /v1/sessions/:id/trajectory embeds the same
// raw agent_snapshot as `agent_config` (buildTrajectory in eval-core has no
// HTTP boundary of its own, so it can't redact) — this route is the
// client-facing seam and must redact before responding, same as above.

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { buildSessionRoutes } from "./index";
import type { RouteServicesArg } from "../types";
import type { SessionRouter } from "@duyet/oma-session-runtime";
import type { AgentConfig } from "@duyet/oma-shared";

const TENANT = "tenant-1";
const SESSION_ID = "sess_1";

function makeApp(agentSnapshot: AgentConfig) {
  const services = {
    sessions: {
      get: async ({ sessionId }: { sessionId: string }) =>
        sessionId === SESSION_ID
          ? {
              id: SESSION_ID,
              agent_id: agentSnapshot.id,
              agent_snapshot: agentSnapshot,
              environment_id: "env_1",
              status: "idle",
              created_at: new Date().toISOString(),
            }
          : null,
    },
  } as unknown as RouteServicesArg;

  const router: Partial<SessionRouter> = {
    getFullStatus: async () => null,
    getTrajectory: async () => ({
      schema_version: "oma.trajectory.v1",
      trajectory_id: "tr_1",
      session_id: SESSION_ID,
      agent_config: agentSnapshot,
      environment_config: {},
      model: { id: "claude-sonnet-4-6", provider: "" },
      started_at: new Date().toISOString(),
      outcome: "running",
      events: [],
      summary: {
        num_events: 0,
        num_turns: 0,
        num_tool_calls: 0,
        num_tool_errors: 0,
        num_threads: 0,
        duration_ms: 0,
        token_usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
      },
    }),
  };

  const app = new Hono<{ Variables: { tenant_id: string } }>();
  app.use("*", async (c, next) => {
    c.set("tenant_id", TENANT);
    await next();
  });
  app.route("/v1/sessions", buildSessionRoutes({ services, router: router as SessionRouter }));
  return app;
}

describe("GET /v1/sessions/:id — agent_snapshot mcp_servers redaction", () => {
  it("never returns a plaintext authorization_token in the embedded agent", async () => {
    const app = makeApp({
      id: "agent_1",
      name: "test",
      model: "claude-sonnet-4-6",
      system: "",
      tools: [],
      mcp_servers: [
        {
          name: "s1",
          type: "url",
          url: "https://example.com/mcp",
          authorization_token: "secret-123",
        },
      ],
      version: 1,
      created_at: new Date().toISOString(),
    } as AgentConfig);

    const res = await app.request(`/v1/sessions/${SESSION_ID}`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      agent: { mcp_servers: Array<{ authorization_token?: string; has_authorization_token?: boolean }> };
    };
    expect(json.agent.mcp_servers[0].authorization_token).toBeUndefined();
    expect(json.agent.mcp_servers[0].has_authorization_token).toBe(true);
  });
});

describe("GET /v1/sessions/:id/trajectory — agent_config mcp_servers redaction (issue #223)", () => {
  it("never returns a plaintext authorization_token in the trajectory's agent_config", async () => {
    const app = makeApp({
      id: "agent_1",
      name: "test",
      model: "claude-sonnet-4-6",
      system: "",
      tools: [],
      mcp_servers: [
        {
          name: "s1",
          type: "url",
          url: "https://example.com/mcp",
          authorization_token: "secret-123",
        },
      ],
      version: 1,
      created_at: new Date().toISOString(),
    } as AgentConfig);

    const res = await app.request(`/v1/sessions/${SESSION_ID}/trajectory`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      agent_config: {
        mcp_servers: Array<{ authorization_token?: string; has_authorization_token?: boolean }>;
      };
    };
    expect(json.agent_config.mcp_servers[0].authorization_token).toBeUndefined();
    expect(json.agent_config.mcp_servers[0].has_authorization_token).toBe(true);
  });
});
