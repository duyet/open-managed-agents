// @ts-nocheck
// Route test for the MCP proxy health-check endpoint (Issue #91 acceptance:
// "MCP proxy health check on sandbox status page"). Drives the exported
// mcp-proxy Hono app with an in-memory KV + fake sessions/credentials
// services. Verifies per-server ok/unresolved status and auth gating —
// provider-agnostic, since it only touches credential resolution.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

// Real connectivity probe (?probe=1, issue #201). Stubs globalThis.fetch
// per case since probeUpstream is a plain fetch + AbortController — no
// need for the sequenced-handler mock test/unit/mcp-proxy-refresh.test.ts
// uses, since each case here only needs one canned upstream response.
describe("GET /_health/:sid?probe=1 (issue #201)", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("probes and reports ok + latency_ms when the upstream responds 2xx", async () => {
    globalThis.fetch = (async () =>
      new Response('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}', {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    const app = await makeApp({
      mcpServers: [{ name: "linear", type: "http", url: "https://linear.app/mcp" }],
      withCred: true,
    });
    // Explicit {} bindings object — a real Worker always provides one
    // (only individual optional bindings inside it are ever absent);
    // omitting the 3rd arg here would leave c.env undefined, which
    // isn't a state production code needs to tolerate.
    const res = await app.request(`/_health/${SID}?probe=1`, auth, {});
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.servers).toHaveLength(1);
    expect(json.servers[0].name).toBe("linear");
    expect(json.servers[0].status).toBe("ok");
    expect(typeof json.servers[0].latency_ms).toBe("number");
  });

  it("reports unreachable when the upstream fetch throws (connection refused)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as typeof fetch;

    const app = await makeApp({
      mcpServers: [{ name: "linear", type: "http", url: "https://linear.app/mcp" }],
      withCred: true,
    });
    const res = await app.request(`/_health/${SID}?probe=1`, auth, {});
    // Response no longer claims "ok" for a server whose upstream is
    // actually unreachable — this is the exact validation issue #201 asks
    // for.
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.servers[0].status).toBe("unreachable");
    expect(typeof json.servers[0].latency_ms).toBe("number");
  });

  it("reports unreachable when the upstream responds non-2xx", async () => {
    globalThis.fetch = (async () =>
      new Response('{"error":"internal"}', { status: 500 })) as typeof fetch;

    const app = await makeApp({
      mcpServers: [{ name: "linear", type: "http", url: "https://linear.app/mcp" }],
      withCred: true,
    });
    const res = await app.request(`/_health/${SID}?probe=1`, auth, {});
    const json = await res.json();
    expect(json.servers[0].status).toBe("unreachable");
    // Also assert latency_ms is present — proves this came from a real
    // probeUpstream execution reading a 500, not from an unrelated thrown
    // exception that happens to also render as "unreachable" (the
    // allSettled rejection fallback omits latency_ms; a genuine probe
    // result never does).
    expect(typeof json.servers[0].latency_ms).toBe("number");
  });

  it("skips the probe (no fetch call) for a server whose credential doesn't resolve", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const app = await makeApp({
      mcpServers: [{ name: "linear", type: "http", url: "https://linear.app/mcp" }],
      withCred: false,
    });
    const res = await app.request(`/_health/${SID}?probe=1`, auth);
    const json = await res.json();
    expect(json.servers).toEqual([{ name: "linear", status: "unresolved" }]);
    expect(fetchCalled).toBe(false);
  });

  it("does NOT probe when ?probe=1 is absent — default stays fast/free", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const app = await makeApp({
      mcpServers: [{ name: "linear", type: "http", url: "https://linear.app/mcp" }],
      withCred: true,
    });
    const res = await app.request(`/_health/${SID}`, auth);
    const json = await res.json();
    expect(json.servers).toEqual([{ name: "linear", status: "ok" }]);
    expect(fetchCalled).toBe(false);
  });

  it("degrades to presence-only ok when the tenant's shared MCP rate-limit budget is spent", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const app = await makeApp({
      mcpServers: [{ name: "linear", type: "http", url: "https://linear.app/mcp" }],
      withCred: true,
    });
    // Third arg to Hono's .request() is the Env bindings object — stubs
    // RL_MCP_PROXY_TENANT as already-exhausted, same shape issue #200's
    // tests use ({ limit: async () => ({ success }) }).
    const res = await app.request(`/_health/${SID}?probe=1`, auth, {
      RL_MCP_PROXY_TENANT: { limit: async () => ({ success: false }) },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.servers).toEqual([{ name: "linear", status: "ok" }]);
    expect(fetchCalled).toBe(false);
  });
});
