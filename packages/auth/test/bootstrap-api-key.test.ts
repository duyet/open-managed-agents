// Coverage for the static bootstrapApiKey check in createAuthMiddleware
// (oma#168) — the Node/self-host equivalent of apps/main's legacy
// env.API_KEY compat check, so a fresh install with no api_keys rows yet
// can still call the REST API. Fake in-memory deps, no DB.
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import {
  createAuthMiddleware,
  type AuthMiddlewareDeps,
} from "../src/index";

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

describe("bootstrapApiKey (oma#168)", () => {
  it("matching x-api-key → tenant_id=default, resolveApiKey never consulted", async () => {
    const resolveApiKey = vi.fn(async () => null);
    const app = buildApp(baseDeps({ bootstrapApiKey: "oma_bootstrap_123", resolveApiKey }));

    const res = await app.request("/whoami", {
      headers: { "x-api-key": "oma_bootstrap_123" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tenant_id: "default", user_id: null });
    expect(resolveApiKey).not.toHaveBeenCalled();
  });

  it("non-matching x-api-key → falls through to resolveApiKey (DB lookup)", async () => {
    const resolveApiKey = vi.fn(async (key: string) =>
      key === "real_minted_key" ? { tenantId: "tn_real", userId: "usr_1" } : null,
    );
    const app = buildApp(baseDeps({ bootstrapApiKey: "oma_bootstrap_123", resolveApiKey }));

    const res = await app.request("/whoami", {
      headers: { "x-api-key": "real_minted_key" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tenant_id: "tn_real", user_id: "usr_1" });
    expect(resolveApiKey).toHaveBeenCalledWith("real_minted_key");
  });

  it("bootstrapApiKey unset (default) → x-api-key always goes through resolveApiKey, no behavior change", async () => {
    const resolveApiKey = vi.fn(async () => null);
    const app = buildApp(baseDeps({ resolveApiKey }));

    const res = await app.request("/whoami", {
      headers: { "x-api-key": "anything" },
    });

    expect(res.status).toBe(401);
    expect(resolveApiKey).toHaveBeenCalledWith("anything");
  });

  it("bootstrapApiKey set to empty string → never matches (no accidental wildcard on an empty header)", async () => {
    const resolveApiKey = vi.fn(async () => null);
    const app = buildApp(baseDeps({ bootstrapApiKey: "", resolveApiKey }));

    const res = await app.request("/whoami", {
      headers: { "x-api-key": "" },
    });

    // Hono's header() returns undefined for an absent/empty header, so this
    // exercises the "no x-api-key sent at all" 401 path, not a bypass.
    expect(res.status).toBe(401);
  });

  it("AUTH_DISABLED still short-circuits before bootstrapApiKey is ever consulted", async () => {
    const app = buildApp(baseDeps({ disabled: true, bootstrapApiKey: "oma_bootstrap_123" }));

    const res = await app.request("/whoami", {
      headers: { "x-api-key": "wrong-key" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tenant_id: "default", user_id: null });
  });
});
