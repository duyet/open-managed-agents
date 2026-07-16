// Unified OAuth "Connect" routes — one consistent install surface shared by
// every integration that supports a plain OAuth-app handshake (Linear,
// GitHub, Slack, and any future provider).
//
//   GET /oauth/:provider/start?return_url=...
//     → mint a signed CSRF state (oauth-state.ts), redirect the browser to
//       the provider's consent page.
//   GET /oauth/:provider/callback?code=&state=
//     → verify state, exchange the code for a token, hand the token to the
//       host's `storeToken` (which writes it into the tenant's vault), then
//       redirect back to `return_url` with a `?connected=<provider>` flag.
//
// The provider-specific bits are just a client id / secret / scopes / URLs
// (UnifiedProviderConfig). Everything else — CSRF, expiry, token exchange,
// redirect handling — is provider-agnostic and lives here, so adding a new
// integration is a config entry, not another bespoke callback. Providers that
// need a richer multi-step install (e.g. Slack's manifest/publication flow, or
// GitHub App manifests) keep their existing gateway routes; this surface is
// the common denominator the Console hub drives.

import { Hono } from "hono";
import { buildAuthorizeUrl, completeOAuthFlow, type OAuthProvider } from "@duyet/oma-integrations-core";
import { getLogger } from "@duyet/oma-observability";
import { mintOAuthState, verifyOAuthState } from "./oauth-state";

const log = getLogger("apps.integrations.oauth-unified");

/** Per-provider OAuth-app config. `null`/absent means "not configured on this
 *  deployment" → the routes 501 cleanly rather than half-running. */
export interface UnifiedProviderConfig {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
}

export interface StoreTokenArgs {
  provider: string;
  userId: string;
  tenantId: string;
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
}

/** The authenticated identity behind a connect flow. */
export interface OAuthIdentity {
  userId: string;
  tenantId: string;
}

export interface UnifiedOAuthDeps {
  /** State-signing secret (seeded from PLATFORM_ROOT_SECRET). */
  secret: string;
  /** Public origin of this gateway, no trailing slash — builds redirect_uri. */
  gatewayOrigin: string;
  /** Configured providers keyed by id. Unknown / null id → 501. */
  providers: Record<string, UnifiedProviderConfig | null | undefined>;
  /** Resolve the authenticated identity from the request. Returns null when
   *  unauthenticated → routes 401. */
  resolveIdentity(req: Request): Promise<OAuthIdentity | null>;
  /** Persist the exchanged token into the tenant's vault. The host owns the
   *  vault plumbing; this module just hands over the plaintext token once. */
  storeToken(args: StoreTokenArgs): Promise<void>;
}

function callbackUrl(origin: string, provider: string): string {
  return `${origin.replace(/\/+$/, "")}/oauth/${encodeURIComponent(provider)}/callback`;
}

function toOAuthProvider(
  id: string,
  cfg: UnifiedProviderConfig,
  redirectUri: string,
): OAuthProvider {
  return {
    id,
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    authorizeUrl: cfg.authorizeUrl,
    tokenUrl: cfg.tokenUrl,
    scopes: cfg.scopes,
    redirectUri,
  };
}

/** Only allow same-origin relative return paths, to stop an open-redirect via
 *  a crafted `return_url`. Anything else falls back to the Console root. */
function safeReturnUrl(raw: string | null): string {
  if (!raw) return "/integrations";
  if (raw.startsWith("/") && !raw.startsWith("//")) return raw;
  return "/integrations";
}

export function buildUnifiedOAuthRoutes(deps: UnifiedOAuthDeps) {
  const app = new Hono();

  // ─── Start ────────────────────────────────────────────────────────────
  app.get("/oauth/:provider/start", async (c) => {
    const provider = c.req.param("provider");
    const cfg = deps.providers[provider];
    if (!cfg) {
      return c.json(
        { error: "provider_not_configured", details: `no OAuth app registered for '${provider}'` },
        501,
      );
    }
    const identity = await deps.resolveIdentity(c.req.raw);
    if (!identity) return c.json({ error: "unauthorized" }, 401);

    const returnUrl = safeReturnUrl(new URL(c.req.url).searchParams.get("return_url"));
    const state = await mintOAuthState(deps.secret, {
      provider,
      userId: identity.userId,
      tenantId: identity.tenantId,
      returnUrl,
    });
    const redirectUri = callbackUrl(deps.gatewayOrigin, provider);
    const authorizeUrl = buildAuthorizeUrl(toOAuthProvider(provider, cfg, redirectUri), state);
    return c.redirect(authorizeUrl, 302);
  });

  // ─── Callback ─────────────────────────────────────────────────────────
  app.get("/oauth/:provider/callback", async (c) => {
    const provider = c.req.param("provider");
    const url = new URL(c.req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const providerError = url.searchParams.get("error");

    const cfg = deps.providers[provider];
    if (!cfg) {
      return c.json(
        { error: "provider_not_configured", details: `no OAuth app registered for '${provider}'` },
        501,
      );
    }

    if (!state) return c.json({ error: "missing_state" }, 400);
    const verified = await verifyOAuthState(deps.secret, state);
    if (!verified.ok) {
      // CSRF failure — never trust the return_url from an unverifiable state.
      return c.json({ error: "invalid_state", reason: verified.reason }, 400);
    }
    // Cross-check the path provider against the state's provider so a state
    // minted for one provider can't be replayed at another's callback.
    if (verified.payload.provider !== provider) {
      return c.json({ error: "provider_mismatch" }, 400);
    }

    const returnUrl = safeReturnUrl(verified.payload.returnUrl);

    // User denied consent (or the provider bounced with an error) — bounce
    // them back to the hub with an error flag instead of a raw JSON blob.
    if (providerError) {
      const target = new URL(returnUrl, url.origin);
      target.searchParams.set("connect_error", providerError);
      target.searchParams.set("provider", provider);
      return c.redirect(target.pathname + target.search, 302);
    }
    if (!code) return c.json({ error: "missing_code" }, 400);

    try {
      const redirectUri = callbackUrl(deps.gatewayOrigin, provider);
      const token = await completeOAuthFlow(code, toOAuthProvider(provider, cfg, redirectUri));
      await deps.storeToken({
        provider,
        userId: verified.payload.userId,
        tenantId: verified.payload.tenantId,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresIn: token.expiresIn,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ op: "oauth.unified.callback.failed", provider, err: msg }, "unified oauth callback failed");
      const target = new URL(returnUrl, url.origin);
      target.searchParams.set("connect_error", "token_exchange_failed");
      target.searchParams.set("provider", provider);
      return c.redirect(target.pathname + target.search, 302);
    }

    const target = new URL(returnUrl, url.origin);
    target.searchParams.set("connected", provider);
    return c.redirect(target.pathname + target.search, 302);
  });

  return app;
}

/** Build the provider config map from env-configured OAuth app credentials.
 *  A provider whose client id/secret aren't set is left out (→ 501 on use). */
export function buildUnifiedProvidersFromEnv(env: {
  LINEAR_OAUTH_CLIENT_ID?: string;
  LINEAR_OAUTH_CLIENT_SECRET?: string;
  GITHUB_OAUTH_CLIENT_ID?: string;
  GITHUB_OAUTH_CLIENT_SECRET?: string;
  SLACK_OAUTH_CLIENT_ID?: string;
  SLACK_OAUTH_CLIENT_SECRET?: string;
}): Record<string, UnifiedProviderConfig | null> {
  return {
    linear:
      env.LINEAR_OAUTH_CLIENT_ID && env.LINEAR_OAUTH_CLIENT_SECRET
        ? {
            clientId: env.LINEAR_OAUTH_CLIENT_ID,
            clientSecret: env.LINEAR_OAUTH_CLIENT_SECRET,
            authorizeUrl: "https://linear.app/oauth/authorize",
            tokenUrl: "https://api.linear.app/oauth/token",
            scopes: ["read", "write", "app:assignable", "app:mentionable"],
          }
        : null,
    github:
      env.GITHUB_OAUTH_CLIENT_ID && env.GITHUB_OAUTH_CLIENT_SECRET
        ? {
            clientId: env.GITHUB_OAUTH_CLIENT_ID,
            clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET,
            authorizeUrl: "https://github.com/login/oauth/authorize",
            tokenUrl: "https://github.com/login/oauth/access_token",
            scopes: ["repo", "read:org"],
          }
        : null,
    slack:
      env.SLACK_OAUTH_CLIENT_ID && env.SLACK_OAUTH_CLIENT_SECRET
        ? {
            clientId: env.SLACK_OAUTH_CLIENT_ID,
            clientSecret: env.SLACK_OAUTH_CLIENT_SECRET,
            authorizeUrl: "https://slack.com/oauth/v2/authorize",
            tokenUrl: "https://slack.com/api/oauth.v2.access",
            scopes: ["chat:write", "channels:read", "app_mentions:read"],
          }
        : null,
  };
}
