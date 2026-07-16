// Route tests for issue #196: mcp_servers[].authorization_token must never
// be returned in plaintext by an agent API response, and a redacted-read ->
// unmodified-write round-trip must not clobber the stored token. Drives the
// Hono app directly against an in-memory AgentService — same accessor shape
// every other http-routes factory takes.

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

describe("agents routes — mcp_servers[].authorization_token redaction (#196)", () => {
  it("create response never returns the plaintext token", async () => {
    const { app } = makeApp();
    const res = await post(
      app,
      agentBody({
        mcp_servers: [
          {
            name: "s1",
            type: "url",
            url: "https://example.com/mcp",
            authorization_token: "secret-123",
          },
        ],
      }),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      mcp_servers: Array<{ authorization_token?: string; has_authorization_token?: boolean }>;
    };
    expect(json.mcp_servers[0].authorization_token).toBeUndefined();
    expect(json.mcp_servers[0].has_authorization_token).toBe(true);
  });

  it("GET agent never returns the plaintext token", async () => {
    const { app } = makeApp();
    const created = (await (
      await post(
        app,
        agentBody({
          mcp_servers: [
            {
              name: "s1",
              type: "url",
              url: "https://example.com/mcp",
              authorization_token: "secret-123",
            },
          ],
        }),
      )
    ).json()) as { id: string };

    const res = await app.request(`/v1/agents/${created.id}`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      mcp_servers: Array<{ authorization_token?: string; has_authorization_token?: boolean }>;
    };
    expect(json.mcp_servers[0].authorization_token).toBeUndefined();
    expect(json.mcp_servers[0].has_authorization_token).toBe(true);
  });

  it("list agents never returns the plaintext token", async () => {
    const { app } = makeApp();
    await post(
      app,
      agentBody({
        mcp_servers: [
          {
            name: "s1",
            type: "url",
            url: "https://example.com/mcp",
            authorization_token: "secret-123",
          },
        ],
      }),
    );
    const res = await app.request("/v1/agents");
    const json = (await res.json()) as {
      data: Array<{ mcp_servers: Array<{ authorization_token?: string }> }>;
    };
    expect(json.data[0].mcp_servers[0].authorization_token).toBeUndefined();
  });

  it("PUT that omits mcp_servers[].authorization_token preserves the stored token", async () => {
    const { app, agents } = makeApp();
    const created = (await (
      await post(
        app,
        agentBody({
          mcp_servers: [
            {
              name: "s1",
              type: "url",
              url: "https://example.com/mcp",
              authorization_token: "secret-123",
            },
          ],
        }),
      )
    ).json()) as { id: string };

    // Simulate a client that fetches the (redacted) agent, edits an
    // unrelated field, and PUTs the whole object back — the exact
    // round-trip that would silently clobber the token without
    // reconciliation.
    const fetched = (await (await app.request(`/v1/agents/${created.id}`)).json()) as Record<
      string,
      unknown
    >;
    const putRes = await put(app, created.id, { ...fetched, name: "renamed" });
    expect(putRes.status).toBe(200);
    const updated = (await putRes.json()) as {
      name: string;
      mcp_servers: Array<{ authorization_token?: string; has_authorization_token?: boolean }>;
    };
    expect(updated.name).toBe("renamed");
    expect(updated.mcp_servers[0].authorization_token).toBeUndefined();
    expect(updated.mcp_servers[0].has_authorization_token).toBe(true);

    // The underlying stored config must still hold the REAL token — this is
    // what the MCP proxy resolves against (apps/main/src/routes/mcp-proxy.ts,
    // apps/main-node/src/mcp-proxy.ts read agent_snapshot directly, not the
    // HTTP-formatted response).
    const stored = await agents.get({ tenantId: TENANT, agentId: created.id });
    expect(stored?.mcp_servers?.[0].authorization_token).toBe("secret-123");
  });

  it("PUT with an explicit new authorization_token rotates it", async () => {
    const { app, agents } = makeApp();
    const created = (await (
      await post(
        app,
        agentBody({
          mcp_servers: [
            {
              name: "s1",
              type: "url",
              url: "https://example.com/mcp",
              authorization_token: "secret-123",
            },
          ],
        }),
      )
    ).json()) as { id: string };

    const putRes = await put(app, created.id, {
      mcp_servers: [
        {
          name: "s1",
          type: "url",
          url: "https://example.com/mcp",
          authorization_token: "rotated-456",
        },
      ],
    });
    expect(putRes.status).toBe(200);

    const stored = await agents.get({ tenantId: TENANT, agentId: created.id });
    expect(stored?.mcp_servers?.[0].authorization_token).toBe("rotated-456");
  });

  it("PUT with authorization_token: null clears the stored token", async () => {
    const { app, agents } = makeApp();
    const created = (await (
      await post(
        app,
        agentBody({
          mcp_servers: [
            {
              name: "s1",
              type: "url",
              url: "https://example.com/mcp",
              authorization_token: "secret-123",
            },
          ],
        }),
      )
    ).json()) as { id: string };

    const putRes = await put(app, created.id, {
      mcp_servers: [
        { name: "s1", type: "url", url: "https://example.com/mcp", authorization_token: null },
      ],
    });
    expect(putRes.status).toBe(200);

    const stored = await agents.get({ tenantId: TENANT, agentId: created.id });
    expect(stored?.mcp_servers?.[0].authorization_token).toBeUndefined();
  });
});
