// @ts-nocheck
import { describe, it, expect } from "vitest";
import { buildTools } from "../../apps/agent/src/harness/tools";
import { TestSandbox } from "../../apps/agent/src/runtime/sandbox";
import type { AgentConfig } from "@duyet/oma-shared";

// buildTools' MCP discovery (apps/agent/src/harness/tools.ts) talks to the
// real @ai-sdk/mcp client, which speaks actual Streamable-HTTP MCP over
// whatever `fetch` the caller supplies via `env.mcpBinding.fetch` — in
// production that's a Worker binding to the main worker's MCP proxy. Rather
// than mocking @ai-sdk/mcp itself (it's a nested dependency of apps/agent
// only, not hoisted to the workspace root — vi.mock can't reliably
// intercept it from a root-level test file), this fakes the *other* end of
// the wire: a minimal spec-compliant MCP responder behind `mcpBinding.fetch`
// that answers `initialize` / `notifications/initialized` / `tools/list`
// with configurable per-server delay and success/failure, so the real SDK
// client runs unmodified end to end.

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface FakeServerBehavior {
  /** Delay applied before answering this server's `initialize` call —
   *  models a slow MCP connection setup, which is exactly what #198 is
   *  about (client setup + tools() discovery blocking one at a time). */
  initDelayMs?: number;
  /** When true, the `initialize` call fails (HTTP 500) after the delay —
   *  models an unreachable/misconfigured upstream MCP server. */
  fails?: boolean;
  /** Tool names this server reports via `tools/list`. */
  toolNames?: string[];
}

/** Builds an `env.mcpBinding.fetch` that speaks just enough real MCP
 *  Streamable-HTTP protocol (initialize → notifications/initialized →
 *  tools/list) to drive @ai-sdk/mcp's real client end to end, keyed by the
 *  `x-oma-mcp-server` header buildTools' proxyFetch stamps on every
 *  request. */
function fakeMcpBinding(behaviors: Record<string, FakeServerBehavior>) {
  return {
    fetch: async (req: Request): Promise<Response> => {
      const serverName = req.headers.get("x-oma-mcp-server") ?? "";
      const behavior = behaviors[serverName];
      if (!behavior) {
        return new Response(`test bug: no fake behavior for server "${serverName}"`, { status: 404 });
      }
      if (req.method === "GET") {
        // @ai-sdk/mcp opens a best-effort inbound SSE stream on connect;
        // 405 tells it this server doesn't support server-initiated
        // pushes, which it handles as a normal no-op (not an error).
        return new Response(null, { status: 405 });
      }
      if (req.method !== "POST") {
        return new Response(null, { status: 404 });
      }
      const body = (await req.json()) as { id?: number; method?: string };
      if (body.method === "initialize" && behavior.initDelayMs) {
        await sleep(behavior.initDelayMs);
      }
      if (behavior.fails) {
        return new Response("simulated upstream MCP failure", { status: 500 });
      }
      const isNotification = !("id" in body);
      if (isNotification) {
        // e.g. notifications/initialized — no reply body needed.
        return new Response(null, { status: 200 });
      }
      if (body.method === "initialize") {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: `fake-${serverName}`, version: "1.0.0" },
          },
        });
      }
      if (body.method === "tools/list") {
        const toolNames = behavior.toolNames ?? [];
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: toolNames.map((name) => ({
              name,
              inputSchema: { type: "object", properties: {} },
            })),
          },
        });
      }
      return new Response(null, { status: 404 });
    },
  };
}

function makeAgentConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    id: "agent_test_mcp_parallel",
    name: "MCP Parallel Test Agent",
    model: "claude-sonnet-4-6",
    system: "",
    tools: [{ type: "agent_toolset_20260401" }],
    version: 1,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("buildTools — parallel MCP server discovery (#198)", () => {
  it("discovers all servers concurrently, preserves config order in the merged tool set regardless of completion order, and a slow + a failing server don't block the fast ones", async () => {
    // Config order is zeta, broken, alpha, mu — deliberately neither
    // alphabetical nor completion order (mu answers fastest, zeta
    // slowest). Passing this test rules out both "sorted by name" and
    // "sorted by whichever server answers first" regressions. The
    // prompt-cache contract (harness/interface.ts) requires buildTools'
    // output to be byte-deterministic, so tool insertion order must depend
    // only on agentConfig.mcp_servers config order — never on network
    // timing.
    const servers = [
      { name: "zeta", type: "http", url: "https://zeta.example.com/mcp" },
      { name: "broken", type: "http", url: "https://broken.example.com/mcp" },
      { name: "alpha", type: "http", url: "https://alpha.example.com/mcp" },
      { name: "mu", type: "http", url: "https://mu.example.com/mcp" },
    ];

    const mcpBinding = fakeMcpBinding({
      zeta: { initDelayMs: 200, toolNames: ["toolZ"] },
      broken: { initDelayMs: 10, fails: true },
      alpha: { initDelayMs: 120, toolNames: ["toolA"] },
      mu: { initDelayMs: 20, toolNames: ["toolM"] },
    });

    const start = Date.now();
    const tools = await buildTools(
      makeAgentConfig({ mcp_servers: servers }),
      new TestSandbox(),
      { mcpBinding, tenantId: "tenant_test", sessionId: "sess_test" },
    );
    const elapsed = Date.now() - start;

    // Order: config order, with the failing server contributing nothing.
    const mcpToolKeys = Object.keys(tools).filter((k) => k.startsWith("mcp__"));
    expect(mcpToolKeys).toEqual([
      "mcp__zeta__toolZ",
      "mcp__alpha__toolA",
      "mcp__mu__toolM",
    ]);

    // Parallelism: sequential execution (the pre-#198 behavior) would take
    // at least 200 + 10 + 120 + 20 = 350ms. Run concurrently, wall-clock
    // must still cover the single slowest server (buildTools awaits every
    // closure via Promise.allSettled) but should stay well under the
    // sequential sum — proving the slow server and the failing one don't
    // block the two faster servers.
    expect(elapsed).toBeGreaterThanOrEqual(190);
    expect(elapsed).toBeLessThan(300);
  });

  it("a single failing server is skipped without failing the whole discovery batch", async () => {
    const servers = [
      { name: "good", type: "http", url: "https://good.example.com/mcp" },
      { name: "bad", type: "http", url: "https://bad.example.com/mcp" },
    ];
    const mcpBinding = fakeMcpBinding({
      good: { initDelayMs: 5, toolNames: ["ok"] },
      bad: { initDelayMs: 5, fails: true },
    });

    const tools = await buildTools(
      makeAgentConfig({ mcp_servers: servers }),
      new TestSandbox(),
      { mcpBinding, tenantId: "tenant_test", sessionId: "sess_test" },
    );

    expect(tools.mcp__good__ok).toBeDefined();
    expect(Object.keys(tools).some((k) => k.startsWith("mcp__bad__"))).toBe(false);
  });
});
