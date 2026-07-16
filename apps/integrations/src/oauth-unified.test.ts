import { describe, it, expect, vi } from "vitest";
import { buildUnifiedOAuthRoutes, type UnifiedProviderConfig } from "./oauth-unified";
import { mintOAuthState } from "./oauth-state";

const SECRET = "unified-test-secret";
const ORIGIN = "https://integrations.example.com";

const LINEAR_CFG: UnifiedProviderConfig = {
  clientId: "cid",
  clientSecret: "csec",
  authorizeUrl: "https://provider.example/authorize",
  tokenUrl: "https://provider.example/token",
  scopes: ["read", "write"],
};

function makeApp(overrides: Partial<Parameters<typeof buildUnifiedOAuthRoutes>[0]> = {}) {
  const storeToken = vi.fn(async () => {});
  const app = buildUnifiedOAuthRoutes({
    secret: SECRET,
    gatewayOrigin: ORIGIN,
    providers: { linear: LINEAR_CFG },
    resolveIdentity: async () => ({ userId: "user_1", tenantId: "tenant_1" }),
    storeToken,
    ...overrides,
  });
  return { app, storeToken };
}

describe("unified oauth: start", () => {
  it("redirects to the provider consent page with a signed state", async () => {
    const { app } = makeApp();
    const res = await app.request("/oauth/linear/start?return_url=/integrations/linear");
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://provider.example/authorize");
    expect(loc.searchParams.get("client_id")).toBe("cid");
    expect(loc.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/oauth/linear/callback`);
    expect(loc.searchParams.get("state")).toBeTruthy();
  });

  it("501s for an unconfigured provider", async () => {
    const { app } = makeApp();
    const res = await app.request("/oauth/notreal/start");
    expect(res.status).toBe(501);
  });

  it("401s when unauthenticated", async () => {
    const { app } = makeApp({ resolveIdentity: async () => null });
    const res = await app.request("/oauth/linear/start");
    expect(res.status).toBe(401);
  });
});

describe("unified oauth: callback", () => {
  it("exchanges the code, stores the token, and redirects with connected flag", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ access_token: "tok_abc", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    try {
      const { app, storeToken } = makeApp();
      const state = await mintOAuthState(SECRET, {
        provider: "linear",
        userId: "user_1",
        tenantId: "tenant_1",
        returnUrl: "/integrations/linear",
      });
      const res = await app.request(
        `/oauth/linear/callback?code=xyz&state=${encodeURIComponent(state)}`,
      );
      expect(res.status).toBe(302);
      const loc = res.headers.get("location")!;
      expect(loc).toBe("/integrations/linear?connected=linear");
      expect(storeToken).toHaveBeenCalledWith({
        provider: "linear",
        userId: "user_1",
        tenantId: "tenant_1",
        accessToken: "tok_abc",
        refreshToken: undefined,
        expiresIn: 3600,
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("rejects a tampered/invalid state (CSRF) without exchanging", async () => {
    const { app, storeToken } = makeApp();
    const res = await app.request("/oauth/linear/callback?code=xyz&state=forged.sig");
    expect(res.status).toBe(400);
    expect(storeToken).not.toHaveBeenCalled();
  });

  it("rejects a state minted for a different provider", async () => {
    const { app } = makeApp({ providers: { linear: LINEAR_CFG, slack: LINEAR_CFG } });
    const state = await mintOAuthState(SECRET, {
      provider: "slack",
      userId: "user_1",
      tenantId: "tenant_1",
      returnUrl: "/x",
    });
    const res = await app.request(
      `/oauth/linear/callback?code=xyz&state=${encodeURIComponent(state)}`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("provider_mismatch");
  });

  it("bounces provider-denied consent back to the hub with an error flag", async () => {
    const { app, storeToken } = makeApp();
    const state = await mintOAuthState(SECRET, {
      provider: "linear",
      userId: "user_1",
      tenantId: "tenant_1",
      returnUrl: "/integrations/linear",
    });
    const res = await app.request(
      `/oauth/linear/callback?error=access_denied&state=${encodeURIComponent(state)}`,
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get("location")!;
    expect(loc).toContain("connect_error=access_denied");
    expect(loc).toContain("provider=linear");
    expect(storeToken).not.toHaveBeenCalled();
  });
});
