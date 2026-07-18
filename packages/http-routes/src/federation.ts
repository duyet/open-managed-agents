/**
 * Cross-instance federation registry (issue #132).
 *
 * A tenant registers a remote OMA instance ONCE (base URL + API key) and then
 * references it from an agent's `callable_agents` roster via a
 * `{ type: "remote_agent", instance_id, remote_agent_id }` entry. The agent
 * harness generates a `call_remote_agent_*` tool that opens a session on the
 * remote instance and delegates the task (see packages/shared/src/federation.ts
 * for the delegation client, and apps/agent's tools.ts for the tool wiring).
 *
 * Storage mirrors the MCP server registry: KV rows under
 * `federation:<tenant>:<id>`, so this mounts identically on Cloudflare and
 * self-host Node. The one difference from the MCP registry is that the remote
 * API key is a real secret we must hold to authenticate outbound — it is
 * encrypted at rest (AES-256-GCM under FEDERATION_CRYPTO_LABEL) and never
 * echoed back; reads surface `has_api_key` instead.
 */

import { Hono } from "hono";
import type { CredentialBlobCrypto } from "@duyet/oma-shared";
import {
  federationKvKey,
  federationKvPrefix,
  listRemoteAgents,
  resolveFederationInstance,
  type FederationInstanceRow,
} from "@duyet/oma-shared";
import type { RouteServicesArg } from "./types";
import { resolveServices } from "./types";

interface Vars {
  Variables: { tenant_id: string };
}

const NAME_RE = /^[a-zA-Z0-9_ -]{1,60}$/;

function validUrl(u: unknown): u is string {
  if (typeof u !== "string" || u.length === 0) return false;
  try {
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function toApiShape(row: FederationInstanceRow) {
  return {
    id: row.id,
    name: row.name,
    base_url: row.base_url,
    has_api_key: Boolean(row.api_key_enc),
    description: row.description,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export interface FederationRoutesDeps {
  services: RouteServicesArg;
  /** At-rest crypto for the stored remote API key. Each runtime builds this
   *  from PLATFORM_ROOT_SECRET under FEDERATION_CRYPTO_LABEL. When absent
   *  (legacy fixtures / secret unset), the routes refuse to store a key. */
  crypto?: CredentialBlobCrypto | ((c: import("hono").Context) => CredentialBlobCrypto | undefined);
}

function resolveCrypto(
  dep: FederationRoutesDeps["crypto"],
  c: import("hono").Context,
): CredentialBlobCrypto | undefined {
  return typeof dep === "function" ? dep(c) : dep;
}

export function buildFederationRoutes(deps: FederationRoutesDeps) {
  const app = new Hono<Vars>();

  // POST /v1/federation/instances — register a remote instance.
  app.post("/instances", async (c) => {
    const tenantId = c.get("tenant_id");
    const kv = resolveServices(deps.services, c).kv;
    const keyCrypto = resolveCrypto(deps.crypto, c);
    const body = (await c.req.json().catch(() => null)) as
      | { name?: string; base_url?: string; api_key?: string; description?: string }
      | null;
    if (!body || typeof body.name !== "string" || !NAME_RE.test(body.name)) {
      return c.json({ error: "name must match ^[a-zA-Z0-9_ -]{1,60}$" }, 422);
    }
    if (!validUrl(body.base_url)) {
      return c.json({ error: "base_url must be a valid http(s) URL" }, 422);
    }
    if (body.api_key !== undefined && typeof body.api_key !== "string") {
      return c.json({ error: "api_key must be a string" }, 422);
    }
    if (body.api_key && !keyCrypto) {
      return c.json({ error: "server cannot encrypt api_key (PLATFORM_ROOT_SECRET unset)" }, 503);
    }
    const now = Date.now();
    const row: FederationInstanceRow = {
      id: `fed_${crypto.randomUUID().replace(/-/g, "")}`,
      tenant_id: tenantId,
      name: body.name,
      base_url: body.base_url as string,
      api_key_enc:
        body.api_key && keyCrypto ? await keyCrypto.encrypt(body.api_key) : undefined,
      description: typeof body.description === "string" ? body.description : undefined,
      created_at: now,
    };
    await kv.put(federationKvKey(tenantId, row.id), JSON.stringify(row));
    return c.json(toApiShape(row), 201);
  });

  // GET /v1/federation/instances — list this tenant's remote instances.
  app.get("/instances", async (c) => {
    const tenantId = c.get("tenant_id");
    const kv = resolveServices(deps.services, c).kv;
    const prefix = federationKvPrefix(tenantId);
    const rows: FederationInstanceRow[] = [];
    let cursor: string | undefined;
    do {
      const page = await kv.list({ prefix, cursor });
      for (const k of page.keys) {
        const raw = await kv.get(k.name);
        if (!raw) continue;
        try {
          rows.push(JSON.parse(raw) as FederationInstanceRow);
        } catch {
          // Skip malformed rows rather than failing the whole list.
        }
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    rows.sort((a, b) => b.created_at - a.created_at || (b.id > a.id ? 1 : -1));
    return c.json({ data: rows.map(toApiShape) });
  });

  // GET /v1/federation/instances/:id
  app.get("/instances/:id", async (c) => {
    const tenantId = c.get("tenant_id");
    const kv = resolveServices(deps.services, c).kv;
    const raw = await kv.get(federationKvKey(tenantId, c.req.param("id")));
    if (!raw) return c.json({ error: "not found" }, 404);
    return c.json(toApiShape(JSON.parse(raw) as FederationInstanceRow));
  });

  // GET /v1/federation/instances/:id/agents — connectivity probe + remote
  // agent discovery. Server-side call to the remote instance using the stored
  // (decrypted) key, so an operator can pick a `remote_agent_id`.
  app.get("/instances/:id/agents", async (c) => {
    const tenantId = c.get("tenant_id");
    const kv = resolveServices(deps.services, c).kv;
    const crypto = resolveCrypto(deps.crypto, c);
    if (!crypto) return c.json({ error: "federation crypto unavailable" }, 503);
    const target = await resolveFederationInstance(kv, crypto, tenantId, c.req.param("id"));
    if (!target) return c.json({ error: "not found" }, 404);
    try {
      const agents = await listRemoteAgents(target);
      return c.json({ data: agents });
    } catch (e) {
      return c.json(
        { error: "remote_unreachable", detail: e instanceof Error ? e.message : String(e) },
        502,
      );
    }
  });

  // PATCH /v1/federation/instances/:id
  app.patch("/instances/:id", async (c) => {
    const tenantId = c.get("tenant_id");
    const kv = resolveServices(deps.services, c).kv;
    const crypto = resolveCrypto(deps.crypto, c);
    const id = c.req.param("id");
    const raw = await kv.get(federationKvKey(tenantId, id));
    if (!raw) return c.json({ error: "not found" }, 404);
    const row = JSON.parse(raw) as FederationInstanceRow;
    const body = (await c.req.json().catch(() => null)) as
      | { name?: string; base_url?: string; api_key?: string | null; description?: string | null }
      | null;
    if (!body) return c.json({ error: "invalid body" }, 422);
    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !NAME_RE.test(body.name)) {
        return c.json({ error: "name must match ^[a-zA-Z0-9_ -]{1,60}$" }, 422);
      }
      row.name = body.name;
    }
    if (body.base_url !== undefined) {
      if (!validUrl(body.base_url)) return c.json({ error: "base_url must be a valid http(s) URL" }, 422);
      row.base_url = body.base_url;
    }
    if (body.api_key !== undefined) {
      if (body.api_key === null || body.api_key === "") {
        row.api_key_enc = undefined;
      } else if (typeof body.api_key === "string") {
        if (!crypto) {
          return c.json({ error: "server cannot encrypt api_key (PLATFORM_ROOT_SECRET unset)" }, 503);
        }
        row.api_key_enc = await crypto.encrypt(body.api_key);
      } else {
        return c.json({ error: "api_key must be a string or null" }, 422);
      }
    }
    if (body.description !== undefined) {
      row.description =
        typeof body.description === "string" && body.description.length > 0
          ? body.description
          : undefined;
    }
    row.updated_at = Date.now();
    await kv.put(federationKvKey(tenantId, id), JSON.stringify(row));
    return c.json(toApiShape(row));
  });

  // DELETE /v1/federation/instances/:id
  app.delete("/instances/:id", async (c) => {
    const tenantId = c.get("tenant_id");
    const kv = resolveServices(deps.services, c).kv;
    const id = c.req.param("id");
    const raw = await kv.get(federationKvKey(tenantId, id));
    if (!raw) return c.json({ error: "not found" }, 404);
    await kv.delete(federationKvKey(tenantId, id));
    return c.body(null, 204);
  });

  return app;
}
