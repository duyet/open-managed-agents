// @ts-nocheck
// Route test for the MCP proxy health-check endpoint (Issue #91 acceptance:
// "MCP proxy health check on sandbox status page"). Drives the exported
// mcp-proxy Hono app with an in-memory KV + fake sessions/credentials
// services. Verifies per-server ok/unresolved status and auth gating —
// provider-agnostic, since it only touches credential resolution.

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import mcpProxyApp from "./mcp-proxy";
import { InMemoryKvStore } from "@duyet/oma-kv-store";
import { createInMemoryCredentialService } from "../../../../packages/credentials-store/src/test-fakes";

const TENANT = "tn_test";
const VAULT = "vlt_test";
const SID = "sess_test";
const API_KEY = "omak_testkey";

async function sha256(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function makeApp(opts: { mcpServers: unknown[]; withCred?: boolean }) {
  const kv = new InMemoryKvStore();
  await kv.put(`apikey:${await sha256(API_KEY)}`, JSON.stringify({ tenant_id: TENANT }));

  const { service: credentials } = createInMemoryCredentialService();
  if (opts.withCred) {
    await credentials.create({
      tenantId: TENANT,
      vaultId: VAULT,
      displayName: "linear",
      auth: { type: "static_bearer", mcp_server_url: "https://linear.app/mcp", token: "tok" },
    });
  }

  const services = {
    kv,
    credentials,
    sessions: {
      async get({ sessionId }) {
        if (sessionId !== SID) return null;
        return {
          archived_at: null,
          vault_ids: [VAULT],
          agent_snapshot: { mcp_servers: opts.mcpServers },
        };
      },
    },
  };

  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("services", services);
    await next();
  });
  app.route("/", mcpProxyApp);
  return app;
}

const auth = { headers: { authorization: `Bearer ${API_KEY}` } };

describe("GET /_health/:sid", () => {
  it("401 without a bearer", async () => {
    const app = await makeApp({ mcpServers: [] });
    const res = await app.request(`/_health/${SID}`);
    expect(res.status).toBe(401);
  });

  it("403 with an unknown api key", async () => {
    const app = await makeApp({ mcpServers: [] });
    const res = await app.request(`/_health/${SID}`, { headers: { authorization: "Bearer nope" } });
    expect(res.status).toBe(403);
  });

  it("reports ok for a server whose credential resolves", async () => {
    const app = await makeApp({
      mcpServers: [{ name: "linear", type: "http", url: "https://linear.app/mcp" }],
      withCred: true,
    });
    const res = await app.request(`/_health/${SID}`, auth);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.session_id).toBe(SID);
    expect(json.servers).toEqual([{ name: "linear", status: "ok" }]);
  });

  it("reports unresolved for a server with no matching credential", async () => {
    const app = await makeApp({
      mcpServers: [{ name: "linear", type: "http", url: "https://linear.app/mcp" }],
      withCred: false,
    });
    const res = await app.request(`/_health/${SID}`, auth);
    const json = await res.json();
    expect(json.servers).toEqual([{ name: "linear", status: "unresolved" }]);
  });
});
