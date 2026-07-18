/**
 * Hono wrapper for OMA's own MCP server (Issue #199) — mounted at `/v1/mcp`
 * on both apps/main (Cloudflare Worker) and apps/main-node (self-host).
 *
 * Transport: MCP Streamable HTTP, JSON mode. The client POSTs a JSON-RPC 2.0
 * message (or batch) and gets a JSON-RPC response. GET returns 405 (we don't
 * expose a server-initiated notification stream — every tool here is plain
 * request/response).
 *
 * Auth: the tenant API key, accepted as either `Authorization: Bearer <key>`
 * (what MCP clients send) or `x-api-key: <key>` (the platform's native
 * header). The key is forwarded verbatim on every subrequest, so tool calls
 * re-enter the platform's own auth + business logic — no tenant resolution or
 * logic is duplicated here.
 *
 * `dispatch` is how a tool call reaches the platform API. Each runtime injects
 * an in-process dispatcher (`app.fetch`) so there's no network hop and no
 * dependency on the worker's public hostname; the default falls back to a
 * same-origin `fetch` for completeness. Tests inject a stub.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { CallApi, JsonRpcRequest, JsonRpcResponse } from "./protocol";
import { handleRpc } from "./protocol";

export { handleRpc, listTools } from "./protocol";
export type { CallApi, JsonRpcRequest, JsonRpcResponse } from "./protocol";

export interface OmaMcpRoutesDeps {
  /** Dispatch an HTTP request to the platform's own API. Defaults to a
   *  same-origin `fetch`. Both runtimes inject `app.fetch` for an in-process
   *  round-trip; tests inject a stub. */
  dispatch?: (req: Request, c: Context) => Response | Promise<Response>;
}

function extractApiKey(c: Context): string | null {
  const auth = c.req.header("authorization") || c.req.header("Authorization");
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1].trim();
  }
  const xkey = c.req.header("x-api-key");
  return xkey ? xkey.trim() : null;
}

function makeCallApi(
  c: Context,
  apiKey: string,
  dispatch: (req: Request, c: Context) => Response | Promise<Response>,
): CallApi {
  const origin = new URL(c.req.url).origin;
  return async (method, path, body) => {
    const headers: Record<string, string> = { "x-api-key": apiKey };
    let payload: string | undefined;
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const req = new Request(new URL(path, origin).toString(), {
      method,
      headers,
      body: payload,
    });
    const res = await dispatch(req, c);
    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { error: text };
      }
    }
    return { status: res.status, json };
  };
}

export function buildOmaMcpRoutes(deps: OmaMcpRoutesDeps = {}) {
  const app = new Hono();
  const dispatch = deps.dispatch ?? ((req: Request) => fetch(req));

  app.post("/", async (c) => {
    const apiKey = extractApiKey(c);
    if (!apiKey) {
      return c.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32001, message: "Unauthorized: provide the tenant API key as a Bearer token" },
        },
        401,
      );
    }

    let parsed: unknown;
    try {
      parsed = await c.req.json();
    } catch {
      return c.json(
        { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
        400,
      );
    }

    const call = makeCallApi(c, apiKey, dispatch);

    // Streamable HTTP allows a single message or a JSON-RPC batch array.
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    const responses: JsonRpcResponse[] = [];
    for (const m of messages) {
      const res = await handleRpc(m as JsonRpcRequest, call);
      if (res) responses.push(res);
    }

    // All-notification batch (or a lone notification): 202, no body — per
    // the Streamable HTTP spec.
    if (responses.length === 0) {
      return c.body(null, 202);
    }
    return c.json(Array.isArray(parsed) ? responses : responses[0]);
  });

  // No server-initiated stream — every tool is request/response.
  app.get("/", (c) => c.json({ error: "Method Not Allowed" }, 405));

  return app;
}
