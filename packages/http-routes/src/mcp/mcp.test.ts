// @ts-nocheck
// Tests for OMA's own MCP server (issue #199). Drives the Hono wrapper
// directly with a stub `dispatch` that stands in for the platform API, so it
// exercises the JSON-RPC transport + tool → REST mapping without a running
// server. Runs in the root Workers pool (no node builtins).

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { buildOmaMcpRoutes } from "./index";

const KEY = "omak_test";

// Stub platform API: validates the forwarded tenant key and returns fixtures
// for the endpoints the MCP tools call.
function stubApi() {
  const seen: Array<{ method: string; path: string; body: unknown }> = [];
  const api = new Hono();
  api.use("*", async (c, next) => {
    if (c.req.header("x-api-key") !== KEY) return c.json({ error: "Invalid API key" }, 401);
    await next();
  });
  api.get("/v1/agents", (c) => c.json({ data: [{ id: "agent_1", name: "A" }] }));
  api.post("/v1/agents", async (c) => {
    const body = await c.req.json();
    seen.push({ method: "POST", path: "/v1/agents", body });
    return c.json({ id: "agent_new", ...body }, 201);
  });
  api.post("/v1/sessions", async (c) => {
    const body = await c.req.json();
    seen.push({ method: "POST", path: "/v1/sessions", body });
    return c.json({ id: "sess_1", ...body }, 201);
  });
  api.post("/v1/sessions/:id/events", async (c) => {
    seen.push({ method: "POST", path: c.req.path, body: await c.req.json() });
    return c.body(null, 202);
  });
  api.get("/v1/sessions/:id/events", (c) =>
    c.json({ events: [{ seq: 1, type: "agent.message" }], has_more: false }),
  );
  return { api, seen };
}

function makeApp() {
  const { api, seen } = stubApi();
  const app = buildOmaMcpRoutes({ dispatch: (req) => api.fetch(req) });
  const rpc = (msg: unknown, headers: Record<string, string> = { authorization: `Bearer ${KEY}` }) =>
    app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(msg),
    });
  return { rpc, seen };
}

describe("OMA MCP server", () => {
  it("initialize returns server info and echoes protocol version", async () => {
    const { rpc } = makeApp();
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.protocolVersion).toBe("2025-03-26");
    expect(body.result.serverInfo.name).toBe("open-managed-agents");
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it("tools/list exposes the five core tools", async () => {
    const { rpc } = makeApp();
    const res = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const body = await res.json();
    const names = body.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(["create_agent", "create_session", "get_events", "list_agents", "send_message"]);
  });

  it("requires the tenant API key", async () => {
    const { rpc } = makeApp();
    const res = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/list" }, {});
    expect(res.status).toBe(401);
  });

  it("accepts the key via x-api-key too", async () => {
    const { rpc } = makeApp();
    const res = await rpc(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_agents", arguments: {} } },
      { "x-api-key": KEY },
    );
    const body = await res.json();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.data[0].id).toBe("agent_1");
  });

  it("create_agent posts to /v1/agents with the default toolset", async () => {
    const { rpc, seen } = makeApp();
    const res = await rpc({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "create_agent", arguments: { name: "Bot", model: "claude-sonnet-4-6", system: "hi" } },
    });
    const body = await res.json();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.id).toBe("agent_new");
    expect(seen[0].body).toMatchObject({
      name: "Bot",
      model: "claude-sonnet-4-6",
      system: "hi",
      tools: [{ type: "agent_toolset_20260401" }],
    });
  });

  it("create_session maps agent_id → agent and forwards environment_id", async () => {
    const { rpc, seen } = makeApp();
    await rpc({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "create_session", arguments: { agent_id: "agent_1", environment_id: "env_1" } },
    });
    expect(seen[0].body).toEqual({ agent: "agent_1", environment_id: "env_1" });
  });

  it("send_message posts a user.message event", async () => {
    const { rpc, seen } = makeApp();
    const res = await rpc({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "send_message", arguments: { session_id: "sess_1", message: "hello" } },
    });
    const body = await res.json();
    expect(body.result.isError).toBeUndefined();
    expect(seen[0].path).toBe("/v1/sessions/sess_1/events");
    expect(seen[0].body).toEqual({
      events: [{ type: "user.message", content: [{ type: "text", text: "hello" }] }],
    });
  });

  it("get_events reads the session event log with paging query", async () => {
    const { rpc } = makeApp();
    const res = await rpc({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "get_events", arguments: { session_id: "sess_1", after_seq: 0 } },
    });
    const body = await res.json();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.events[0].type).toBe("agent.message");
  });

  it("reports isError for a failing tool call", async () => {
    const { rpc } = makeApp();
    const res = await rpc({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "create_agent", arguments: { name: "Bot" } },
    });
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("model is required");
  });

  it("returns method-not-found for unknown methods", async () => {
    const { rpc } = makeApp();
    const res = await rpc({ jsonrpc: "2.0", id: 9, method: "nope" });
    const body = await res.json();
    expect(body.error.code).toBe(-32601);
  });

  it("accepts notifications with 202 and no body", async () => {
    const { rpc } = makeApp();
    const res = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(202);
  });

  it("GET is not allowed", async () => {
    const { rpc: _rpc } = makeApp();
    const { api } = stubApi();
    const app = buildOmaMcpRoutes({ dispatch: (req) => api.fetch(req) });
    const res = await app.request("/", { method: "GET" });
    expect(res.status).toBe(405);
  });
});
