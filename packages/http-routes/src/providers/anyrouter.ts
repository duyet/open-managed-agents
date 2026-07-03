// AnyRouter upstream provider — OAuth (PKCE) "connect" routes.
//
// Runs AnyRouter's MCP OAuth 2.1 + PKCE + Dynamic Client Registration flow
// (packages/anyrouter has the pure protocol logic) to mint an `sk-ar-…`
// inference key for the signed-in AnyRouter user, without the user ever
// copy-pasting a key out of the AnyRouter dashboard. The minted key is
// persisted as a `static_bearer` credential (provider: "anyrouter") in a
// dedicated "AnyRouter" vault for the caller's tenant, exactly like the
// GitHub/Linear install flows persist their tokens.
//
// Endpoints:
//   GET  /connect      — start the flow (redirects the browser to AnyRouter)
//   GET  /callback      — AnyRouter's OAuth redirect target
//   GET  /status         — is this tenant connected?
//   POST /disconnect    — archive the credential
//   GET  /models        — cached AnyRouter model catalog (GET /api/v1/models)
//
// Node self-host has no D1 model-cards store (see apps/main-node/src/index.ts
// buildModel) — its model provider is process-global env vars
// (ANTHROPIC_API_KEY/ANTHROPIC_BASE_URL/OMA_API_COMPAT). `hooks.onConnected`
// / `onDisconnected` let the Node entrypoint hot-swap an in-process provider
// cache so a fresh OAuth connect takes effect without a restart.

import { Hono } from "hono";
import {
  ANYROUTER_API_BASE,
  ANYROUTER_API_COMPAT,
  ANYROUTER_OAUTH_SCOPE,
  buildAuthorizeUrl,
  buildModelsRequest,
  buildRegisterRequest,
  buildTokenRequest,
  generatePkcePair,
  generateState,
  parseModelsResponse,
  parseRegisterResponse,
  parseTokenResponse,
} from "@open-managed-agents/anyrouter";
import type { KvStore } from "@open-managed-agents/kv-store";
import type { RouteServices, RouteServicesArg } from "../types";
import { resolveServices } from "../types";

interface Vars {
  Variables: { tenant_id: string; user_id?: string };
}

const KV_CLIENT_KEY = "anyrouter:oauth_client";
const KV_PENDING_PREFIX = "anyrouter:oauth_pending:";
const KV_MODELS_CACHE_KEY = "anyrouter:models_cache";
const PENDING_TTL_SECONDS = 10 * 60;
const MODELS_CACHE_TTL_MS = 60 * 60 * 1000;
const VAULT_NAME = "AnyRouter";
const CREDENTIAL_DISPLAY_NAME = "AnyRouter inference key";
const CLIENT_NAME = "Open Managed Agents";

interface StoredClient {
  clientId: string;
  redirectUri: string;
}

interface PendingAuth {
  verifier: string;
  tenantId: string;
  createdAt: number;
}

export interface AnyRouterConnectedInfo {
  tenantId: string;
  vaultId: string;
  credentialId: string;
  apiKey: string;
}

export interface AnyRouterConnectHooks {
  /** Fired right after a new key is persisted, so the caller can hot-swap an
   *  in-process model-provider cache. Best-effort: hook failures are logged
   *  but never fail the OAuth callback response. */
  onConnected?: (info: AnyRouterConnectedInfo) => void | Promise<void>;
  onDisconnected?: (tenantId: string) => void | Promise<void>;
}

export interface AnyRouterRoutesDeps {
  services: RouteServicesArg;
  /** Public origin this OMA deployment is reachable at, e.g.
   *  "https://oma.example.com" (no trailing slash). Used to build the fixed
   *  OAuth redirect_uri registered with AnyRouter — must be HTTPS, or
   *  http+loopback per AnyRouter's redirect_uri validator. */
  publicOrigin: string;
  /** Where to send the browser after connect/disconnect completes, e.g. a
   *  Console URL such as "https://console.example.com/model_cards". */
  returnUrl: string;
  hooks?: AnyRouterConnectHooks;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export function buildAnyRouterRoutes(deps: AnyRouterRoutesDeps) {
  const app = new Hono<Vars>();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const redirectUri = `${deps.publicOrigin.replace(/\/+$/, "")}/v1/providers/anyrouter/callback`;

  async function ensureClient(kv: KvStore): Promise<StoredClient> {
    const cached = await kv.get(KV_CLIENT_KEY);
    if (cached) {
      const parsed = JSON.parse(cached) as StoredClient;
      if (parsed.clientId && parsed.redirectUri === redirectUri) return parsed;
    }
    const req = buildRegisterRequest({ clientName: CLIENT_NAME, redirectUris: [redirectUri] });
    const res = await fetchImpl(req.url, { method: req.method, headers: req.headers, body: req.body });
    const body = await res.text();
    if (!res.ok) {
      throw new Error(`AnyRouter client registration failed: HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    const client = parseRegisterResponse(body);
    const stored: StoredClient = { clientId: client.clientId, redirectUri };
    await kv.put(KV_CLIENT_KEY, JSON.stringify(stored));
    return stored;
  }

  async function ensureVault(services: RouteServices, tenantId: string): Promise<string> {
    const vaults = await services.vaults.list({ tenantId, includeArchived: false });
    const existing = vaults.find((v) => v.name === VAULT_NAME);
    if (existing) return existing.id;
    const created = await services.vaults.create({ tenantId, name: VAULT_NAME });
    return created.id;
  }

  /** Scan every vault for an active `provider: "anyrouter"` credential. Node
   *  self-host tenants have a small number of vaults, so an N+1 list is
   *  cheap; revisit with a dedicated lookup if that stops being true. */
  async function findCredential(
    services: RouteServices,
    tenantId: string,
  ): Promise<{ vaultId: string; credentialId: string; token: string; createdAt: string } | null> {
    const vaults = await services.vaults.list({ tenantId, includeArchived: false });
    for (const v of vaults) {
      const creds = await services.credentials.list({ tenantId, vaultId: v.id, includeArchived: false });
      const hit = creds.find((c) => c.auth?.provider === "anyrouter" && !c.archived_at);
      if (hit?.auth.token) {
        return { vaultId: v.id, credentialId: hit.id, token: hit.auth.token, createdAt: hit.created_at };
      }
    }
    return null;
  }

  // ── Start the flow ─────────────────────────────────────────────────────
  app.get("/connect", async (c) => {
    const services = resolveServices(deps.services, c);
    const tenantId = c.var.tenant_id;
    if (!tenantId) return c.json({ error: "authentication required" }, 401);

    let client: StoredClient;
    try {
      client = await ensureClient(services.kv);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "client registration failed" }, 502);
    }

    const { verifier, challenge } = await generatePkcePair();
    const state = generateState();
    const pending: PendingAuth = { verifier, tenantId, createdAt: Date.now() };
    await services.kv.put(`${KV_PENDING_PREFIX}${state}`, JSON.stringify(pending), {
      expirationTtl: PENDING_TTL_SECONDS,
    });

    const url = buildAuthorizeUrl({
      clientId: client.clientId,
      redirectUri,
      state,
      codeChallenge: challenge,
      scope: ANYROUTER_OAUTH_SCOPE,
    });
    return c.redirect(url, 302);
  });

  // ── AnyRouter's redirect target ─────────────────────────────────────────
  app.get("/callback", async (c) => {
    const services = resolveServices(deps.services, c);
    const fail = (msg: string) =>
      c.redirect(`${deps.returnUrl}?anyrouter_error=${encodeURIComponent(msg)}`, 302);

    const oauthError = c.req.query("error");
    if (oauthError) return fail(oauthError);

    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) return fail("missing code or state");

    const pendingRaw = await services.kv.get(`${KV_PENDING_PREFIX}${state}`);
    if (!pendingRaw) return fail("expired or unknown state");
    await services.kv.delete(`${KV_PENDING_PREFIX}${state}`);
    const pending = JSON.parse(pendingRaw) as PendingAuth;

    const clientRaw = await services.kv.get(KV_CLIENT_KEY);
    if (!clientRaw) return fail("no registered oauth client — retry /connect");
    const client = JSON.parse(clientRaw) as StoredClient;

    const tokenReq = buildTokenRequest({
      clientId: client.clientId,
      redirectUri,
      code,
      codeVerifier: pending.verifier,
    });
    const res = await fetchImpl(tokenReq.url, {
      method: tokenReq.method,
      headers: tokenReq.headers,
      body: tokenReq.body,
    });
    const body = await res.text();
    if (!res.ok) return fail(`token exchange failed: HTTP ${res.status}`);

    let token: { accessToken: string };
    try {
      token = parseTokenResponse(body);
    } catch (err) {
      return fail(err instanceof Error ? err.message : "token parse error");
    }

    const vaultId = await ensureVault(services, pending.tenantId);

    // Archive any prior AnyRouter credential in this vault so reconnecting
    // doesn't accumulate stale keys the outbound proxy might still pick up.
    const existing = await services.credentials.list({ tenantId: pending.tenantId, vaultId });
    for (const cred of existing) {
      if (cred.auth?.provider === "anyrouter" && !cred.archived_at) {
        await services.credentials
          .archive({ tenantId: pending.tenantId, vaultId, credentialId: cred.id })
          .catch(() => {});
      }
    }

    const created = await services.credentials.create({
      tenantId: pending.tenantId,
      vaultId,
      displayName: CREDENTIAL_DISPLAY_NAME,
      auth: { type: "static_bearer", token: token.accessToken, provider: "anyrouter" },
    });

    try {
      await deps.hooks?.onConnected?.({
        tenantId: pending.tenantId,
        vaultId,
        credentialId: created.id,
        apiKey: token.accessToken,
      });
    } catch (err) {
      services.logger?.warn({ err }, "anyrouter.onConnected hook failed");
    }

    return c.redirect(`${deps.returnUrl}?anyrouter_connected=1`, 302);
  });

  // ── Status + disconnect ─────────────────────────────────────────────────
  app.get("/status", async (c) => {
    const services = resolveServices(deps.services, c);
    const tenantId = c.var.tenant_id;
    if (!tenantId) return c.json({ error: "authentication required" }, 401);
    const hit = await findCredential(services, tenantId);
    if (!hit) return c.json({ connected: false });
    return c.json({
      connected: true,
      vault_id: hit.vaultId,
      credential_id: hit.credentialId,
      base_url: ANYROUTER_API_BASE,
      compat: ANYROUTER_API_COMPAT,
      connected_at: hit.createdAt,
    });
  });

  app.post("/disconnect", async (c) => {
    const services = resolveServices(deps.services, c);
    const tenantId = c.var.tenant_id;
    if (!tenantId) return c.json({ error: "authentication required" }, 401);
    const hit = await findCredential(services, tenantId);
    if (!hit) return c.json({ disconnected: false });
    await services.credentials.archive({ tenantId, vaultId: hit.vaultId, credentialId: hit.credentialId });
    try {
      await deps.hooks?.onDisconnected?.(tenantId);
    } catch (err) {
      services.logger?.warn({ err }, "anyrouter.onDisconnected hook failed");
    }
    return c.json({ disconnected: true });
  });

  // ── Model catalog (for a model picker) ──────────────────────────────────
  app.get("/models", async (c) => {
    const services = resolveServices(deps.services, c);
    const tenantId = c.var.tenant_id;
    if (!tenantId) return c.json({ error: "authentication required" }, 401);

    const cached = await services.kv.get(KV_MODELS_CACHE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached) as { fetchedAt: number; models: unknown[] };
      if (Date.now() - parsed.fetchedAt < MODELS_CACHE_TTL_MS) {
        return c.json({ data: parsed.models, cached: true });
      }
    }

    const hit = await findCredential(services, tenantId);
    if (!hit) return c.json({ data: [], connect_required: true });

    const req = buildModelsRequest(hit.token);
    const res = await fetchImpl(req.url, { headers: req.headers });
    if (!res.ok) return c.json({ data: [], error: `HTTP ${res.status}` }, 502);
    const models = parseModelsResponse(await res.text());
    await services.kv.put(KV_MODELS_CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), models }));
    return c.json({ data: models });
  });

  return app;
}
