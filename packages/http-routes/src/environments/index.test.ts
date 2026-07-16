// Route-level coverage for the environments bundle — the port that fixes
// POST /v1/environments 404ing on the self-hosted (main-node) host. Exercises
// create / list / get / update / archive / delete plus the 400 (validation),
// 404 (not found), and 409 (delete-with-active-sessions) paths.

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { createInMemoryEnvironmentService, ManualClock } from "@duyet/oma-environments-store/test-fakes";
import { InMemoryKvStore } from "@duyet/oma-kv-store";
import { buildEnvironmentRoutes } from "./index";
import { envSecretKey } from "./env-vars";
import type { RouteServicesArg } from "../types";

const TENANT = "tenant-1";

// Flip this to make the sessions stub report an active session for the
// delete-409 path. The environments bundle only calls
// sessions.hasActiveByEnvironment, so a one-method stub is enough.
let sessionsHasActive = false;

function makeApp() {
  const { service: environments, repo } = createInMemoryEnvironmentService({
    clock: new ManualClock(1_000),
  });

  const sessions = {
    hasActiveByEnvironment: async () => sessionsHasActive,
  };

  const kv = new InMemoryKvStore();

  const services = {
    environments,
    sessions,
    kv,
  } as unknown as RouteServicesArg;

  const app = new Hono<{ Variables: { tenant_id: string } }>();
  app.use("*", async (c, next) => {
    c.set("tenant_id", TENANT);
    await next();
  });
  app.route("/v1/environments", buildEnvironmentRoutes({ services }));
  return { app, repo, environments, kv };
}

async function createEnv(
  app: Hono<{ Variables: { tenant_id: string } }>,
  body: Record<string, unknown>,
) {
  return app.request("/v1/environments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("environments routes", () => {
  beforeEach(() => {
    sessionsHasActive = false;
  });

  it("POST / creates an environment (201) with the resource envelope", async () => {
    const { app } = makeApp();
    const res = await createEnv(app, { name: "prod", config: { type: "e2b" } });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.type).toBe("environment");
    expect(body.id).toBeTruthy();
    expect(body.name).toBe("prod");
    expect((body.config as { type: string }).type).toBe("e2b");
  });

  it("POST / defaults config to { type: 'cloud' } when omitted", async () => {
    const { app } = makeApp();
    const res = await createEnv(app, { name: "default-env" });
    const body = (await res.json()) as { config: { type: string } };
    expect(body.config.type).toBe("cloud");
  });

  it("POST / rejects a missing name (400)", async () => {
    const { app } = makeApp();
    const res = await createEnv(app, { config: { type: "cloud" } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("name is required");
  });

  it("POST / rejects an over-long name via field-size caps (400)", async () => {
    const { app } = makeApp();
    const res = await createEnv(app, { name: "x".repeat(257) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/name length/);
  });

  it("GET / lists environments with the { data, has_more } shape", async () => {
    const { app } = makeApp();
    await createEnv(app, { name: "a" });
    await createEnv(app, { name: "b" });
    const res = await app.request("/v1/environments");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; has_more: boolean };
    expect(body.data).toHaveLength(2);
    expect(body.has_more).toBe(false);
  });

  it("GET / rejects an unknown status (400)", async () => {
    const { app } = makeApp();
    const res = await app.request("/v1/environments?status=bogus");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_status");
  });

  it("GET / rejects an unparseable created_after (400)", async () => {
    const { app } = makeApp();
    const res = await app.request("/v1/environments?created_after=not-a-date");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_timestamp");
  });

  it("GET /:id returns the environment, or 404 when unknown", async () => {
    const { app } = makeApp();
    const created = (await (await createEnv(app, { name: "one" })).json()) as { id: string };
    const ok = await app.request(`/v1/environments/${created.id}`);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { id: string }).id).toBe(created.id);

    const missing = await app.request("/v1/environments/env-does-not-exist");
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: string }).error).toBe("Environment not found");
  });

  it("PUT /:id updates fields, or 404 when unknown", async () => {
    const { app } = makeApp();
    const created = (await (await createEnv(app, { name: "before" })).json()) as { id: string };
    const res = await app.request(`/v1/environments/${created.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "after" }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { name: string }).name).toBe("after");

    const missing = await app.request("/v1/environments/nope", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(missing.status).toBe(404);
  });

  it("POST /:id/archive sets archived_at, or 404 when unknown", async () => {
    const { app } = makeApp();
    const created = (await (await createEnv(app, { name: "arch" })).json()) as { id: string };
    const res = await app.request(`/v1/environments/${created.id}/archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { archived_at: string }).archived_at).toBeTruthy();

    const missing = await app.request("/v1/environments/nope/archive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(missing.status).toBe(404);
  });

  it("DELETE /:id removes the environment when there are no active sessions", async () => {
    const { app } = makeApp();
    const created = (await (await createEnv(app, { name: "del" })).json()) as { id: string };
    const res = await app.request(`/v1/environments/${created.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect((await res.json())).toEqual({ type: "environment_deleted", id: created.id });

    const gone = await app.request(`/v1/environments/${created.id}`);
    expect(gone.status).toBe(404);
  });

  it("DELETE /:id refuses (409) while the environment has active sessions", async () => {
    const { app } = makeApp();
    const created = (await (await createEnv(app, { name: "busy" })).json()) as { id: string };
    sessionsHasActive = true;
    const res = await app.request(`/v1/environments/${created.id}`, { method: "DELETE" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/active sessions/);
  });

  // ── Environment-level env vars ─────────────────────────────────────────

  type EnvVarOut = { name: string; value?: string; sensitive?: boolean; has_value?: boolean };

  it("POST / stores non-sensitive env vars inline and keeps sensitive values out of the response", async () => {
    const { app, kv } = makeApp();
    const res = await createEnv(app, {
      name: "with-vars",
      config: {
        type: "cloud",
        env_vars: [
          { name: "LOG_LEVEL", value: "debug" },
          { name: "API_TOKEN", value: "supersecret", sensitive: true },
        ],
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; config: { env_vars: EnvVarOut[] } };
    const vars = body.config.env_vars;

    const plain = vars.find((v) => v.name === "LOG_LEVEL")!;
    expect(plain.value).toBe("debug");
    expect(plain.sensitive).toBeFalsy();

    const secret = vars.find((v) => v.name === "API_TOKEN")!;
    expect(secret.sensitive).toBe(true);
    expect(secret.has_value).toBe(true);
    expect(secret.value).toBeUndefined();

    // The secret value is written to KV, never persisted in the record.
    expect(await kv.get(envSecretKey(TENANT, body.id, "API_TOKEN"))).toBe("supersecret");
    expect(JSON.stringify(body)).not.toContain("supersecret");
  });

  it("PUT /:id rotates a sensitive value, preserves it when omitted, and purges removed secrets", async () => {
    const { app, kv } = makeApp();
    const created = (await (
      await createEnv(app, {
        name: "rotate",
        config: {
          type: "cloud",
          env_vars: [
            { name: "TOKEN_A", value: "a1", sensitive: true },
            { name: "TOKEN_B", value: "b1", sensitive: true },
          ],
        },
      })
    ).json()) as { id: string };

    // Update: rotate TOKEN_A, keep TOKEN_B (no value supplied), drop nothing new.
    const res = await app.request(`/v1/environments/${created.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        config: {
          type: "cloud",
          env_vars: [
            { name: "TOKEN_A", value: "a2", sensitive: true },
            { name: "TOKEN_B", sensitive: true },
          ],
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(await kv.get(envSecretKey(TENANT, created.id, "TOKEN_A"))).toBe("a2");
    expect(await kv.get(envSecretKey(TENANT, created.id, "TOKEN_B"))).toBe("b1");

    // Update: drop TOKEN_B entirely → its secret is purged.
    await app.request(`/v1/environments/${created.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        config: { type: "cloud", env_vars: [{ name: "TOKEN_A", sensitive: true }] },
      }),
    });
    expect(await kv.get(envSecretKey(TENANT, created.id, "TOKEN_B"))).toBeNull();
  });

  it("POST / rejects an invalid env-var name (400)", async () => {
    const { app } = makeApp();
    const res = await createEnv(app, {
      name: "bad",
      config: { type: "cloud", env_vars: [{ name: "has space", value: "x" }] },
    });
    expect(res.status).toBe(400);
  });

  it("DELETE /:id purges the environment's sensitive secrets from KV", async () => {
    const { app, kv } = makeApp();
    const created = (await (
      await createEnv(app, {
        name: "del-secrets",
        config: { type: "cloud", env_vars: [{ name: "SECRET", value: "s", sensitive: true }] },
      })
    ).json()) as { id: string };
    expect(await kv.get(envSecretKey(TENANT, created.id, "SECRET"))).toBe("s");
    await app.request(`/v1/environments/${created.id}`, { method: "DELETE" });
    expect(await kv.get(envSecretKey(TENANT, created.id, "SECRET"))).toBeNull();
  });
});
