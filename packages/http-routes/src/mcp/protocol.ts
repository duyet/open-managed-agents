/**
 * OMA's own MCP server (Issue #199).
 *
 * A single streamable-HTTP endpoint (`POST /v1/mcp`) that exposes the core
 * platform operations as MCP tools, so OMA can be driven from Claude
 * Desktop / Claude Code / Cursor / VS Code without a bespoke SDK. The
 * transport is the JSON mode of MCP Streamable HTTP: the client POSTs a
 * JSON-RPC 2.0 message and gets a JSON-RPC response back (no SSE needed for
 * these request/response tools).
 *
 * This module is the pure, runtime-agnostic core: it knows nothing about
 * Hono, env, or fetch. Every tool is implemented by calling back into the
 * platform's *own* HTTP API through the injected `callApi` — zero business
 * logic is duplicated here, so create_session/send_message/etc. get the exact
 * same lifecycle (sandbox provisioning, gates, credential injection) as a
 * direct REST call. The Hono wrapper in `./index.ts` supplies `callApi` and
 * the tenant API key; tests supply a stub.
 */

/** MCP protocol version we implement. We echo the client's requested version
 *  when it sends a string, else advertise this. */
export const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

export const SERVER_INFO = {
  name: "open-managed-agents",
  version: "0.1.0",
} as const;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Outcome of a platform API subrequest. `json` is the parsed body (or a
 *  fallback shape when the body wasn't JSON). */
export interface ApiCallResult {
  status: number;
  json: unknown;
}

/** Injected transport: dispatch a call to the platform's own HTTP API,
 *  already authenticated for the caller's tenant. */
export type CallApi = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<ApiCallResult>;

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, call: CallApi) => Promise<unknown>;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Turn a non-2xx API result into a thrown Error so tools/call reports
 *  `isError: true` with the upstream message. */
function ensureOk(res: ApiCallResult, action: string): unknown {
  if (res.status >= 200 && res.status < 300) return res.json;
  const body = res.json as { error?: unknown } | null;
  const msg =
    (body && typeof body === "object" && "error" in body && str((body as { error?: unknown }).error)) ||
    `HTTP ${res.status}`;
  throw new Error(`${action} failed (${res.status}): ${msg}`);
}

const TOOLS: ToolDef[] = [
  {
    name: "list_agents",
    description:
      "List the agents in the caller's tenant. Returns each agent's id, name, model, and description.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async handler(_args, call) {
      return ensureOk(await call("GET", "/v1/agents"), "list_agents");
    },
  },
  {
    name: "create_agent",
    description:
      "Create a new agent. Provide a name, model handle (e.g. claude-sonnet-4-6), and system prompt. " +
      "Returns the created agent including its id.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Display name for the agent." },
        model: {
          type: "string",
          description: "Model handle, e.g. claude-sonnet-4-6.",
        },
        system: { type: "string", description: "System prompt defining the agent's behavior." },
        description: { type: "string", description: "Optional human-readable description." },
      },
      required: ["name", "model", "system"],
      additionalProperties: false,
    },
    async handler(args, call) {
      const name = str(args.name);
      const model = str(args.model);
      const system = str(args.system);
      if (!name) throw new Error("name is required");
      if (!model) throw new Error("model is required");
      if (!system) throw new Error("system is required");
      const body: Record<string, unknown> = {
        name,
        model,
        system,
        tools: [{ type: "agent_toolset_20260401" }],
      };
      const description = str(args.description);
      if (description) body.description = description;
      return ensureOk(await call("POST", "/v1/agents", body), "create_agent");
    },
  },
  {
    name: "create_session",
    description:
      "Start a new session for an agent. Pass the agent id (and optionally an environment_id). " +
      "Returns the session including its id — pass it to send_message and get_events.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Id of the agent to run." },
        environment_id: {
          type: "string",
          description: "Optional environment id for the sandbox.",
        },
        title: { type: "string", description: "Optional session title." },
      },
      required: ["agent_id"],
      additionalProperties: false,
    },
    async handler(args, call) {
      const agentId = str(args.agent_id);
      if (!agentId) throw new Error("agent_id is required");
      const body: Record<string, unknown> = { agent: agentId };
      const env = str(args.environment_id);
      if (env) body.environment_id = env;
      const title = str(args.title);
      if (title) body.title = title;
      return ensureOk(await call("POST", "/v1/sessions", body), "create_session");
    },
  },
  {
    name: "send_message",
    description:
      "Send a user message to a session. The agent processes it asynchronously — poll get_events to " +
      "read the agent's response and tool activity.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Id of the session." },
        message: { type: "string", description: "The user message text." },
      },
      required: ["session_id", "message"],
      additionalProperties: false,
    },
    async handler(args, call) {
      const sessionId = str(args.session_id);
      const message = str(args.message);
      if (!sessionId) throw new Error("session_id is required");
      if (!message) throw new Error("message is required");
      const body = {
        events: [{ type: "user.message", content: [{ type: "text", text: message }] }],
      };
      const res = await call("POST", `/v1/sessions/${encodeURIComponent(sessionId)}/events`, body);
      ensureOk(res, "send_message");
      return { session_id: sessionId, accepted: true };
    },
  },
  {
    name: "get_events",
    description:
      "Read a session's event log (agent messages, tool use, status). Use after_seq to page past events " +
      "you've already seen. Returns the events array plus paging cursors.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Id of the session." },
        after_seq: {
          type: "number",
          description: "Only return events after this sequence number.",
        },
        limit: { type: "number", description: "Maximum number of events to return." },
        order: {
          type: "string",
          enum: ["asc", "desc"],
          description: "Event ordering (default asc).",
        },
      },
      required: ["session_id"],
      additionalProperties: false,
    },
    async handler(args, call) {
      const sessionId = str(args.session_id);
      if (!sessionId) throw new Error("session_id is required");
      const q = new URLSearchParams();
      if (typeof args.after_seq === "number") q.set("after_seq", String(args.after_seq));
      if (typeof args.limit === "number") q.set("limit", String(args.limit));
      if (args.order === "asc" || args.order === "desc") q.set("order", args.order);
      const qs = q.toString();
      const path = `/v1/sessions/${encodeURIComponent(sessionId)}/events${qs ? `?${qs}` : ""}`;
      return ensureOk(await call("GET", path), "get_events");
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function listTools() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

function ok(id: JsonRpcRequest["id"], result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function err(
  id: JsonRpcRequest["id"],
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

/**
 * Handle one JSON-RPC message. Returns a JSON-RPC response, or `null` for
 * notifications (no `id`) which take no reply. `call` is the authenticated
 * platform-API transport.
 */
export async function handleRpc(
  msg: JsonRpcRequest,
  call: CallApi,
): Promise<JsonRpcResponse | null> {
  const isNotification = msg.id === undefined || msg.id === null;

  switch (msg.method) {
    case "initialize": {
      const params = (msg.params ?? {}) as { protocolVersion?: unknown };
      const protocolVersion =
        typeof params.protocolVersion === "string"
          ? params.protocolVersion
          : DEFAULT_PROTOCOL_VERSION;
      return ok(msg.id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "ping":
      return ok(msg.id, {});
    case "tools/list":
      return ok(msg.id, { tools: listTools() });
    case "tools/call": {
      const params = (msg.params ?? {}) as { name?: unknown; arguments?: unknown };
      const name = str(params.name);
      const tool = name ? TOOL_BY_NAME.get(name) : undefined;
      if (!tool) {
        return err(msg.id, -32602, `Unknown tool: ${name ?? "(none)"}`);
      }
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        const result = await tool.handler(args, call);
        return ok(msg.id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return ok(msg.id, {
          content: [{ type: "text", text: message }],
          isError: true,
        });
      }
    }
    default:
      if (isNotification) return null;
      return err(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}
