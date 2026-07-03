// End-to-end coverage of trusted-proxy auth wired through
// createAuthMiddleware — the "does the feature actually work through the
// full request path" complement to trusted-proxy.test.ts's pure guard
// unit tests. Uses fake in-memory deps (no DB) so this runs fast and
// deterministically.
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import {
  createAuthMiddleware,
  type AuthMiddlewareDeps,
  type AuthSession,
} from "../src/index";

const SHARED_SECRET = "correct-horse-battery-staple";

function buildApp(deps: AuthMiddlewareDeps) {
  const app = new Hono<{ Variables: { tenant_id: string; user_id?: string } }>();
  app.use("*", createAuthMiddleware(deps));
  app.get("/whoami", (c) =>
    c.json({ tenant_id: c.get("tenant_id"), user_id: c.get("user_id") ?? null }),
  );
  return app;
}

function baseDeps(overrides: Partial<AuthMiddlewareDeps> = {}): AuthMiddlewareDeps {
  return {
    disabled: false,
    resolveSession: async () => null,
    resolveApiKey: async () => null,
    defaultTenantForUser: async () => "tn_default",
    hasMembership: async () => true,
    ensureTenantForUser: async () => "tn_default",
    ...overrides,
  };
}

describe("trusted-proxy auth wired through createAuthMiddleware", () => {
  it("enabled + valid secret + resolvable identity → authenticated", async () => {
    const resolve = vi.fn(async (identity): Promise<AuthSession> => ({
      userId: "usr_1",
      email: identity.email,
      name: identity.name,
    }));
    const app = buildApp(
      baseDeps({
        trustedProxy: {
          config: {
            enabled: true,
            userHeader: "x-forwarded-user",
            sharedSecretHeader: "x-trusted-proxy-secret",
            sharedSecret: SHARED_SECRET,
          },
          resolve,
        },
      }),
    );

    const res = await app.request("/whoami", {
      headers: {
        "x-forwarded-user": "alice@example.com",
        "x-trusted-proxy-secret": SHARED_SECRET,
      },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tenant_id: "tn_default", user_id: "usr_1" });
    expect(resolve).toHaveBeenCalledWith({
      subject: "alice@example.com",
      email: "alice@example.com",
      name: "alice",
    });
  });

  it("enabled + missing shared-secret header → rejected (401), never falls through to cookie auth", async () => {
    const resolve = vi.fn();
    const resolveSession = vi.fn(async () => null);
    const app = buildApp(
      baseDeps({
        resolveSession,
        trustedProxy: {
          config: {
            enabled: true,
            userHeader: "x-forwarded-user",
            sharedSecretHeader: "x-trusted-proxy-secret",
            sharedSecret: SHARED_SECRET,
          },
          resolve,
        },
      }),
    );

    const res = await app.request("/whoami", {
      headers: { "x-forwarded-user": "alice@example.com" }, // no secret header
    });

    expect(res.status).toBe(401);
    expect(resolve).not.toHaveBeenCalled();
    // The guard failure must hard-reject, not silently try cookie auth —
    // otherwise a spoofing attempt would look like an ordinary "no
    // session" 401 instead of a distinctly-caused rejection.
    expect(resolveSession).not.toHaveBeenCalled();
  });

  it("enabled + wrong shared-secret (spoofed) → rejected (401)", async () => {
    const resolve = vi.fn();
    const app = buildApp(
      baseDeps({
        trustedProxy: {
          config: {
            enabled: true,
            userHeader: "x-forwarded-user",
            sharedSecretHeader: "x-trusted-proxy-secret",
            sharedSecret: SHARED_SECRET,
          },
          resolve,
        },
      }),
    );

    const res = await app.request("/whoami", {
      headers: {
        "x-forwarded-user": "attacker@evil.example",
        "x-trusted-proxy-secret": "not-the-real-secret",
      },
    });

    expect(res.status).toBe(401);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("trustedProxy dep omitted (disabled/unconfigured) → identity header is completely ignored, cookie auth runs as before", async () => {
    const resolveSession = vi.fn(async (): Promise<AuthSession | null> => ({
      userId: "usr_cookie",
      email: "cookie-user@example.com",
      name: "Cookie User",
    }));
    const app = buildApp(baseDeps({ resolveSession }));

    const res = await app.request("/whoami", {
      headers: {
        // Even a well-formed spoofed header + secret must be a no-op
        // when the runtime never constructed deps.trustedProxy.
        "x-forwarded-user": "attacker@evil.example",
        "x-trusted-proxy-secret": SHARED_SECRET,
        cookie: "better-auth.session_token=irrelevant-to-the-fake",
      },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tenant_id: "tn_default", user_id: "usr_cookie" });
    expect(resolveSession).toHaveBeenCalledTimes(1);
  });

  it("trustedProxy configured but enabled:false → identical no-op behavior", async () => {
    const resolve = vi.fn();
    const resolveSession = vi.fn(async (): Promise<AuthSession | null> => ({
      userId: "usr_cookie",
      email: null,
      name: null,
    }));
    const app = buildApp(
      baseDeps({
        resolveSession,
        trustedProxy: {
          config: {
            enabled: false,
            userHeader: "x-forwarded-user",
            sharedSecretHeader: "x-trusted-proxy-secret",
            sharedSecret: SHARED_SECRET,
          },
          resolve,
        },
      }),
    );

    const res = await app.request("/whoami", {
      headers: {
        "x-forwarded-user": "alice@example.com",
        "x-trusted-proxy-secret": SHARED_SECRET,
      },
    });

    expect(res.status).toBe(200);
    expect(resolve).not.toHaveBeenCalled();
    expect(resolveSession).toHaveBeenCalledTimes(1);
  });

  it("resolve() returning null (e.g. identity resolution failed) → rejected (401)", async () => {
    const app = buildApp(
      baseDeps({
        trustedProxy: {
          config: {
            enabled: true,
            userHeader: "x-forwarded-user",
            sharedSecretHeader: "x-trusted-proxy-secret",
            sharedSecret: SHARED_SECRET,
          },
          resolve: async () => null,
        },
      }),
    );

    const res = await app.request("/whoami", {
      headers: {
        "x-forwarded-user": "alice@example.com",
        "x-trusted-proxy-secret": SHARED_SECRET,
      },
    });

    expect(res.status).toBe(401);
  });

  it("AUTH_DISABLED still short-circuits before trusted-proxy is ever consulted", async () => {
    const resolve = vi.fn();
    const app = buildApp(
      baseDeps({
        disabled: true,
        trustedProxy: {
          config: {
            enabled: true,
            userHeader: "x-forwarded-user",
            sharedSecretHeader: "x-trusted-proxy-secret",
            sharedSecret: SHARED_SECRET,
          },
          resolve,
        },
      }),
    );

    const res = await app.request("/whoami", {
      headers: {
        "x-forwarded-user": "alice@example.com",
        "x-trusted-proxy-secret": SHARED_SECRET,
      },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tenant_id: "default", user_id: null });
    expect(resolve).not.toHaveBeenCalled();
  });
});
