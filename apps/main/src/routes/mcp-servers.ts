/**
 * Tenant-level MCP server registry (Issue #91, Phase 3).
 *
 * Lets a user register a remote MCP server (URL + optional vault credential)
 * ONCE at the tenant level, then reference it from many agents via
 * `agent.mcp_servers[].registry_id` instead of repeating the URL on every
 * agent config. Credential resolution stays vault-based — a registry row
 * only records WHICH server + (optionally) which credential; the plaintext
 * token never lives here, exactly as with inline `mcp_servers` entries.
 *
 * Storage: CONFIG_KV under `mcp_registry:<tenant>:<id>`. A registry is a
 * small, low-cardinality per-tenant list (a handful of servers), so a KV
 * prefix-scan list is cheaper than a new SQL table + migration and keeps
 * this feature fully self-contained. The bytes-of-truth are the KV rows;
 * there is no index to keep consistent.
 *
 * The registry is consumed by the MCP proxy: when a session's agent snapshot
 * has an `mcp_servers` entry carrying `registry_id` (and no inline `url`),
 * `resolveProxyTargetByTenant` calls `resolveRegisteredMcpServer` to expand
 * it into a URL (+ optional credential_id) before resolving the vault token.
 */

import { Hono } from "hono";
import type { Env } from "@duyet/oma-shared";
import type { Services } from "@duyet/oma-services";
import type { KvStore } from "@duyet/oma-kv-store";

const app = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; services: Services };
}>();

export interface McpRegistryRow {
  id: string;
  tenant_id: string;
  name: string;
  url: string;
  /** Optional vault credential id to inject. When unset, the proxy falls
   *  back to matching a vault credential by the server URL (the same rule
   *  inline `mcp_servers` entries use). */
  credential_id?: string;
  description?: string;
  created_at: number;
  updated_at?: number;
}

const kvKey = (tenantId: string, id: string) => `mcp_registry:${tenantId}:${id}`;

function toApiShape(row: McpRegistryRow) {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    credential_id: row.credential_id,
    description: row.description,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Resolve a registered MCP server by id for a tenant. Exported so the MCP
 * proxy can expand `agent.mcp_servers[].registry_id` → URL + credential_id
 * at request time. Returns null on miss / malformed row.
 */
export async function resolveRegisteredMcpServer(
  kv: KvStore,
  tenantId: string,
  id: string,
): Promise<{ url: string; credential_id?: string } | null> {
  const raw = await kv.get(kvKey(tenantId, id)).catch(() => null);
  if (!raw) return null;
  try {
    const row = JSON.parse(raw) as McpRegistryRow;
    if (!row.url) return null;
    return { url: row.url, credential_id: row.credential_id };
  } catch {
    return null;
  }
}

function validUrl(u: unknown): u is string {
  if (typeof u !== "string" || u.length === 0) return false;
  try {
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// POST /v1/mcp_servers — register a server.
app.post("/", async (c) => {
  const tenantId = c.get("tenant_id");
  const body = (await c.req.json().catch(() => null)) as
    | { name?: string; url?: string; credential_id?: string; description?: string }
    | null;
  if (!body || typeof body.name !== "string" || body.name.length === 0) {
    return c.json({ error: "name is required" }, 422);
  }
  if (!validUrl(body.url)) {
    return c.json({ error: "url must be a valid http(s) URL" }, 422);
  }
  const now = Date.now();
  const row: McpRegistryRow = {
    id: `mcps_${crypto.randomUUID().replace(/-/g, "")}`,
    tenant_id: tenantId,
    name: body.name,
    url: body.url,
    credential_id: typeof body.credential_id === "string" ? body.credential_id : undefined,
    description: typeof body.description === "string" ? body.description : undefined,
    created_at: now,
  };
  await c.var.services.kv.put(kvKey(tenantId, row.id), JSON.stringify(row));
  return c.json(toApiShape(row), 201);
});

// GET /v1/mcp_servers — list this tenant's registered servers.
app.get("/", async (c) => {
  const tenantId = c.get("tenant_id");
  const kv = c.var.services.kv;
  const prefix = `mcp_registry:${tenantId}:`;
  const rows: McpRegistryRow[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix, cursor });
    for (const k of page.keys) {
      const raw = await kv.get(k.name);
      if (!raw) continue;
      try {
        rows.push(JSON.parse(raw) as McpRegistryRow);
      } catch {
        // Skip malformed rows rather than failing the whole list.
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  rows.sort((a, b) => b.created_at - a.created_at);
  return c.json({ data: rows.map(toApiShape) });
});

// GET /v1/mcp_servers/:id
app.get("/:id", async (c) => {
  const tenantId = c.get("tenant_id");
  const raw = await c.var.services.kv.get(kvKey(tenantId, c.req.param("id")));
  if (!raw) return c.json({ error: "not found" }, 404);
  return c.json(toApiShape(JSON.parse(raw) as McpRegistryRow));
});

// PATCH /v1/mcp_servers/:id — update name/url/credential/description.
app.patch("/:id", async (c) => {
  const tenantId = c.get("tenant_id");
  const id = c.req.param("id");
  const raw = await c.var.services.kv.get(kvKey(tenantId, id));
  if (!raw) return c.json({ error: "not found" }, 404);
  const row = JSON.parse(raw) as McpRegistryRow;
  const body = (await c.req.json().catch(() => null)) as
    | { name?: string; url?: string; credential_id?: string | null; description?: string | null }
    | null;
  if (!body) return c.json({ error: "invalid body" }, 422);
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || body.name.length === 0) {
      return c.json({ error: "name must be a non-empty string" }, 422);
    }
    row.name = body.name;
  }
  if (body.url !== undefined) {
    if (!validUrl(body.url)) return c.json({ error: "url must be a valid http(s) URL" }, 422);
    row.url = body.url;
  }
  if (body.credential_id !== undefined) {
    row.credential_id =
      typeof body.credential_id === "string" && body.credential_id.length > 0
        ? body.credential_id
        : undefined;
  }
  if (body.description !== undefined) {
    row.description =
      typeof body.description === "string" && body.description.length > 0
        ? body.description
        : undefined;
  }
  row.updated_at = Date.now();
  await c.var.services.kv.put(kvKey(tenantId, id), JSON.stringify(row));
  return c.json(toApiShape(row));
});

// DELETE /v1/mcp_servers/:id
app.delete("/:id", async (c) => {
  const tenantId = c.get("tenant_id");
  const id = c.req.param("id");
  const raw = await c.var.services.kv.get(kvKey(tenantId, id));
  if (!raw) return c.json({ error: "not found" }, 404);
  await c.var.services.kv.delete(kvKey(tenantId, id));
  return c.body(null, 204);
});

export default app;
