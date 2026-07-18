// @ts-nocheck
// Route tests for the cross-instance federation registry (issue #132).
// Same in-memory-KV harness as the MCP server registry — drives the Hono app
// directly through the shared `services` RouteServicesArg, so this exercises
// exactly what apps/main and apps/main-node mount.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { buildFederationRoutes } from "./federation";
import { InMemoryKvStore } from "@duyet/oma-kv-store";
import { buildLabeledCrypto, FEDERATION_CRYPTO_LABEL } from "@duyet/oma-shared";
import type { RouteServices } from "./types";

const TENANT = "tn_test";
const crypto = buildLabeledCrypto("root-secret-for-tests", FEDERATION_CRYPTO_LABEL);

function makeApp(kv: InMemoryKvStore, tenantId = TENANT) {
  const app = new Hono<{ Variables: { tenant_id: string } }>();
  app.use("*", async (c, next) => {
    c.set("tenant_id", tenantId);
    await next();
  });
  const routes = buildFederationRoutes({
    services: { kv } as unknown as RouteServices,
    crypto,
  });
  app.route("/", routes);
  return app;
}

describe("federation registry routes", () => {
  let kv: InMemoryKvStore;
  let app: Hono;
  beforeEach(() => {
    kv = new InMemoryKvStore();
    app = makeApp(kv);
  });

  const post = (body: unknown) =>
    app.request("/instances", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("creates an instance and never echoes the api key", async () => {
    const res = await post({
      name: "peer prod",
      base_url: "https://peer.example.com",
      api_key: "omak_secret",
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.id).toMatch(/^fed_/);
    expect(json.name).toBe("peer prod");
    expect(json.has_api_key).toBe(true);
    // The plaintext key must never appear in the response body.
    expect(JSON.stringify(json)).not.toContain("omak_secret");
    expect(json.api_key).toBeUndefined();
  });

  it("stores the api key encrypted at rest (not plaintext in KV)", async () => {
    const created = await (await post({
      name: "peer",
      base_url: "https://peer.example.com",
      api_key: "omak_secret",
    })).json();
    const raw = await kv.get(`federation:${TENANT}:${created.id}`);
    expect(raw).not.toContain("omak_secret");
    const row = JSON.parse(raw);
    expect(await crypto.decrypt(row.api_key_enc)).toBe("omak_secret");
  });

  it("rejects a bad base_url (422)", async () => {
    expect((await post({ name: "x", base_url: "ftp://nope" })).status).toBe(422);
  });

  it("rejects a missing name (422)", async () => {
    expect((await post({ base_url: "https://peer.example.com" })).status).toBe(422);
  });

  it("lists only this tenant's instances, newest first", async () => {
    await post({ name: "a", base_url: "https://a.example.com" });
    await new Promise((r) => setTimeout(r, 2));
    await post({ name: "b", base_url: "https://b.example.com" });
    const other = makeApp(kv, "tn_other");
    await other.request("/instances", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "z", base_url: "https://z.example.com" }),
    });
    const json = await (await app.request("/instances")).json();
    expect(json.data.map((r) => r.name)).toEqual(["b", "a"]);
  });

  it("updates and can clear the api key", async () => {
    const created = await (await post({
      name: "peer",
      base_url: "https://peer.example.com",
      api_key: "omak_secret",
    })).json();
    // rotate
    let res = await app.request(`/instances/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: "omak_rotated", name: "peer2" }),
    });
    expect(res.status).toBe(200);
    let json = await res.json();
    expect(json.name).toBe("peer2");
    expect(json.has_api_key).toBe(true);
    const raw = JSON.parse(await kv.get(`federation:${TENANT}:${created.id}`));
    expect(await crypto.decrypt(raw.api_key_enc)).toBe("omak_rotated");
    // clear
    res = await app.request(`/instances/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: null }),
    });
    json = await res.json();
    expect(json.has_api_key).toBe(false);
  });

  it("gets and deletes an instance", async () => {
    const created = await (await post({ name: "peer", base_url: "https://peer.example.com" })).json();
    expect((await app.request(`/instances/${created.id}`)).status).toBe(200);
    expect((await app.request(`/instances/${created.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await app.request(`/instances/${created.id}`)).status).toBe(404);
  });

  it("refuses to store an api key when crypto is unavailable (503)", async () => {
    const noCrypto = new Hono<{ Variables: { tenant_id: string } }>();
    noCrypto.use("*", async (c, next) => {
      c.set("tenant_id", TENANT);
      await next();
    });
    noCrypto.route("/", buildFederationRoutes({ services: { kv } as unknown as RouteServices }));
    const res = await noCrypto.request("/instances", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x", base_url: "https://peer.example.com", api_key: "k" }),
    });
    expect(res.status).toBe(503);
  });
});

describe("federation agents probe", () => {
  let kv: InMemoryKvStore;
  let app: Hono;
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    kv = new InMemoryKvStore();
    app = makeApp(kv);
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("proxies to the remote /v1/agents with the stored key", async () => {
    const created = await (await app.request("/instances", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "peer", base_url: "https://peer.example.com", api_key: "omak_k" }),
    })).json();

    globalThis.fetch = (async (url, init) => {
      expect(String(url)).toBe("https://peer.example.com/v1/agents");
      expect(init?.headers?.["x-api-key"]).toBe("omak_k");
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: [{ id: "agent_remote", name: "R" }] };
        },
        async text() {
          return "";
        },
      };
    }) as unknown as typeof fetch;

    const res = await app.request(`/instances/${created.id}/agents`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual([{ id: "agent_remote", name: "R" }]);
  });

  it("returns 502 when the remote is unreachable", async () => {
    const created = await (await app.request("/instances", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "peer", base_url: "https://peer.example.com" }),
    })).json();
    globalThis.fetch = (async () => ({
      ok: false,
      status: 500,
      async json() {
        return {};
      },
      async text() {
        return "";
      },
    })) as unknown as typeof fetch;
    const res = await app.request(`/instances/${created.id}/agents`);
    expect(res.status).toBe(502);
  });
});
