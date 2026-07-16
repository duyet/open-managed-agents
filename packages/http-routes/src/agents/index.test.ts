// Route tests for issue #197: mcp_servers[].name has zero validation, and
// an unsafe name (empty, bad charset, duplicate within one agent) silently
// breaks every derived mcp_* tool on that server once it reaches the model
// API. Drives the Hono app directly against an in-memory AgentService —
// same accessor shape every other http-routes factory takes.

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createInMemoryAgentService } from "@duyet/oma-agents-store/test-fakes";
import { buildAgentRoutes } from "./index";
import type { RouteServicesArg } from "../types";

const TENANT = "tn_test";

function makeApp() {
  const { service: agents } = createInMemoryAgentService();
  const services = { agents } as unknown as RouteServicesArg;
  const app = new Hono<{ Variables: { tenant_id: string } }>();
  app.use("*", async (c, next) => {
    c.set("tenant_id", TENANT);
    await next();
  });
  app.route("/v1/agents", buildAgentRoutes({ services }));
  return { app, agents };
}

function agentBody(overrides: Record<string, unknown> = {}) {
  return {
    name: "test agent",
    model: "claude-sonnet-4-6",
    system: "You are helpful.",
    ...overrides,
  };
}

function post(app: Hono<{ Variables: { tenant_id: string } }>, body: unknown) {
  return app.request("/v1/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function put(app: Hono<{ Variables: { tenant_id: string } }>, id: string, body: unknown) {
  return app.request(`/v1/agents/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("agents routes — mcp_servers[].name validation (#197)", () => {
  it("rejects an empty name on create (422)", async () => {
    const { app } = makeApp();
    const res = await post(
      app,
      agentBody({ mcp_servers: [{ name: "", type: "url", url: "https://example.com/mcp" }] }),
    );
    expect(res.status).toBe(422);
  });

  it("rejects a bad-charset name on create (422)", async () => {
    const { app } = makeApp();
    const res = await post(
      app,
      agentBody({
        mcp_servers: [{ name: "bad name!", type: "url", url: "https://example.com/mcp" }],
      }),
    );
    expect(res.status).toBe(422);
  });

  it("rejects a name over 40 chars on create (422)", async () => {
    const { app } = makeApp();
    const res = await post(
      app,
      agentBody({
        mcp_servers: [{ name: "x".repeat(41), type: "url", url: "https://example.com/mcp" }],
      }),
    );
    expect(res.status).toBe(422);
  });

  it("rejects duplicate names within one agent on create (422)", async () => {
    const { app } = makeApp();
    const res = await post(
      app,
      agentBody({
        mcp_servers: [
          { name: "dup", type: "url", url: "https://a.example/mcp" },
          { name: "dup", type: "url", url: "https://b.example/mcp" },
        ],
      }),
    );
    expect(res.status).toBe(422);
  });

  it("accepts a valid name on create (201)", async () => {
    const { app } = makeApp();
    const res = await post(
      app,
      agentBody({
        mcp_servers: [{ name: "linear-1", type: "url", url: "https://example.com/mcp" }],
      }),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as { mcp_servers: Array<{ name: string }> };
    expect(json.mcp_servers[0].name).toBe("linear-1");
  });

  it("rejects a bad-charset name on update (422)", async () => {
    const { app } = makeApp();
    const created = (await (await post(app, agentBody())).json()) as { id: string };
    const res = await put(app, created.id, {
      mcp_servers: [{ name: "bad name", type: "url", url: "https://x.example/mcp" }],
    });
    expect(res.status).toBe(422);
  });

  it("rejects duplicate names on update (422)", async () => {
    const { app } = makeApp();
    const created = (await (await post(app, agentBody())).json()) as { id: string };
    const res = await put(app, created.id, {
      mcp_servers: [
        { name: "dup", type: "url", url: "https://a.example/mcp" },
        { name: "dup", type: "url", url: "https://b.example/mcp" },
      ],
    });
    expect(res.status).toBe(422);
  });

  it("accepts a valid name on update (200)", async () => {
    const { app } = makeApp();
    const created = (await (await post(app, agentBody())).json()) as { id: string };
    const res = await put(app, created.id, {
      mcp_servers: [{ name: "renamed_server-2", type: "url", url: "https://x.example/mcp" }],
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { mcp_servers: Array<{ name: string }> };
    expect(json.mcp_servers[0].name).toBe("renamed_server-2");
  });
});
