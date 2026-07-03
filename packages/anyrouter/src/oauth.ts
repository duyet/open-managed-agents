// AnyRouter MCP OAuth 2.1 + PKCE + Dynamic Client Registration (RFC 7591)
// protocol helpers. Pure logic — build request shapes, parse responses. No
// fetch calls happen here; callers (apps/main-node's route handler) own the
// actual HTTP I/O, matching the style of packages/github/src/oauth/protocol.ts.

import {
  ANYROUTER_OAUTH_AUTHORIZE_URL,
  ANYROUTER_OAUTH_REGISTER_URL,
  ANYROUTER_OAUTH_TOKEN_URL,
} from "./config";

export interface HttpRequestSpec {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  /** Empty string for GET. */
  body: string;
}

// ─── Dynamic Client Registration ───────────────────────────────────────

export interface RegisterClientInput {
  clientName: string;
  redirectUris: string[];
}

/** Open, unauthenticated DCR endpoint — no client secret is issued (PKCE-only
 *  public client), so this can be called fresh on first connect and the
 *  resulting client_id cached indefinitely (redirect_uri is fixed per OMA
 *  deployment, so re-registering would just mint a duplicate row upstream). */
export function buildRegisterRequest(input: RegisterClientInput): HttpRequestSpec {
  return {
    method: "POST",
    url: ANYROUTER_OAUTH_REGISTER_URL,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: input.clientName,
      redirect_uris: input.redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    }),
  };
}

export interface RegisteredClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
}

export function parseRegisterResponse(body: string): RegisteredClient {
  const parsed = JSON.parse(body) as Partial<{
    client_id: string;
    client_name: string;
    redirect_uris: string[];
  }>;
  if (!parsed.client_id || typeof parsed.client_id !== "string") {
    throw new Error(`AnyRouter DCR: missing client_id in response: ${body.slice(0, 200)}`);
  }
  return {
    clientId: parsed.client_id,
    clientName: parsed.client_name ?? "",
    redirectUris: Array.isArray(parsed.redirect_uris) ? parsed.redirect_uris : [],
  };
}

// ─── Authorization redirect ────────────────────────────────────────────

export interface BuildAuthorizeUrlInput {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scope?: string;
}

/** Build the URL to redirect the user's browser to. AnyRouter renders a
 *  Clerk-gated consent screen there and, on approval, 302s the browser back
 *  to `redirectUri` with `?code=...&state=...`. */
export function buildAuthorizeUrl(input: BuildAuthorizeUrlInput): string {
  const url = new URL(ANYROUTER_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", input.state);
  if (input.scope) url.searchParams.set("scope", input.scope);
  return url.toString();
}

// ─── Token exchange ─────────────────────────────────────────────────────

export interface TokenExchangeInput {
  clientId: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
}

export function buildTokenRequest(input: TokenExchangeInput): HttpRequestSpec {
  return {
    method: "POST",
    url: ANYROUTER_OAUTH_TOKEN_URL,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: input.clientId,
      code_verifier: input.codeVerifier,
    }),
  };
}

export interface TokenResponse {
  /** The minted `sk-ar-v1-…` inference key. Shown once — persist immediately. */
  accessToken: string;
  tokenType: string;
  scope: string;
  origin?: string;
}

export function parseTokenResponse(body: string): TokenResponse {
  const parsed = JSON.parse(body) as Partial<{
    access_token: string;
    token_type: string;
    scope: string;
    origin: string;
    error: string;
    error_description: string;
  }>;
  if (!parsed.access_token || typeof parsed.access_token !== "string") {
    const detail = parsed.error_description || parsed.error || body.slice(0, 200);
    throw new Error(`AnyRouter token exchange failed: ${detail}`);
  }
  return {
    accessToken: parsed.access_token,
    tokenType: parsed.token_type ?? "Bearer",
    scope: parsed.scope ?? "",
    origin: parsed.origin,
  };
}
