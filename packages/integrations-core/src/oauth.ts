export interface OAuthProvider {
  id: string;
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  redirectUri: string;
  tokenRefreshUrl?: string;
}

export function buildAuthorizeUrl(provider: OAuthProvider, state: string): string {
  const params = new URLSearchParams();
  params.set("client_id", provider.clientId);
  params.set("redirect_uri", provider.redirectUri);
  params.set("response_type", "code");
  params.set("scope", provider.scopes.join(" "));
  params.set("state", state);
  return `${provider.authorizeUrl}?${params.toString()}`;
}

export async function completeOAuthFlow(
  code: string,
  provider: OAuthProvider,
): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number }> {
  const params = new URLSearchParams();
  params.set("grant_type", "authorization_code");
  params.set("code", code);
  params.set("redirect_uri", provider.redirectUri);
  params.set("client_id", provider.clientId);
  params.set("client_secret", provider.clientSecret);

  const res = await fetch(provider.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "unknown");
    throw new Error(`OAuth token exchange failed: HTTP ${res.status} ${body.slice(0, 200)}`);
  }

  const body = (await res.json()) as Record<string, unknown>;
  if (!body.access_token || typeof body.access_token !== "string") {
    throw new Error("OAuth response missing access_token");
  }

  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" && body.refresh_token.length > 0 ? body.refresh_token : undefined,
    expiresIn: typeof body.expires_in === "number" ? body.expires_in : undefined,
  };
}

export async function refreshOAuthToken(
  refreshToken: string,
  provider: OAuthProvider,
): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number }> {
  const tokenUrl = provider.tokenRefreshUrl ?? provider.tokenUrl;

  const params = new URLSearchParams();
  params.set("grant_type", "refresh_token");
  params.set("refresh_token", refreshToken);
  params.set("client_id", provider.clientId);
  params.set("client_secret", provider.clientSecret);

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "unknown");
    throw new Error(`OAuth token refresh failed: HTTP ${res.status} ${body.slice(0, 200)}`);
  }

  const body = (await res.json()) as Record<string, unknown>;
  if (!body.access_token || typeof body.access_token !== "string") {
    throw new Error("OAuth refresh response missing access_token");
  }

  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" && body.refresh_token.length > 0 ? body.refresh_token : undefined,
    expiresIn: typeof body.expires_in === "number" ? body.expires_in : undefined,
  };
}
