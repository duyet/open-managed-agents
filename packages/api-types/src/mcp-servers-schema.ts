// Zod schema for `AgentConfig.mcp_servers[].name` — see issue #197.
//
// Every upstream MCP tool is surfaced to the model as a synthesized tool id
// `mcp__<server.name>__<toolName>` (apps/agent/src/harness/tools.ts:
// `tools[\`mcp__${server.name}__${toolName}\`] = t;`), which must satisfy
// Anthropic's tool-name contract ^[a-zA-Z0-9_-]{1,128}$. An unvalidated name
// (spaces, emoji, empty string, a duplicate within the same agent) produces
// an invalid or colliding tool id — the former gets the *entire* request's
// tools array rejected by the model API (not just that server), the latter
// silently drops one server's tools when two entries share a name. Neither
// failure points back at the offending mcp_servers entry, so we reject both
// at agent create/update time instead.
//
// Colocated with the wire types in types.ts, same pattern as notify-schema.ts.

import { z } from "zod";

// Cap at 40 chars to leave headroom under Anthropic's 128-char tool-name
// limit for the "mcp__" + "__" separators (7 chars) plus the upstream
// tool name itself.
export const MCP_SERVER_NAME_RE = /^[a-zA-Z0-9_-]{1,40}$/;

const mcpServerEntrySchema = z
  .object({
    name: z
      .string()
      .regex(MCP_SERVER_NAME_RE, "mcp_servers[].name must match ^[a-zA-Z0-9_-]{1,40}$"),
  })
  // Every other field (type, url, registry_id, authorization_token, stdio, ...)
  // is left untouched — this schema only enforces the tool-id-safety
  // constraint on `name`, not the full mcp_servers shape.
  .passthrough();

export const mcpServersSchema = z
  .array(mcpServerEntrySchema)
  .refine(
    (servers) => new Set(servers.map((s) => s.name)).size === servers.length,
    { message: "mcp_servers[].name must be unique within an agent" },
  );
