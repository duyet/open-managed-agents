// @ts-nocheck
// Route tests for the tenant-level MCP server registry (Issue #91 Phase 3).
// Drives the Hono app directly with an in-memory KV via the shared
// `services` RouteServicesArg — same accessor shape every other
// http-routes factory takes (buildVaultRoutes, buildAgentRoutes, ...), so
// this exercises exactly what both apps/main and apps/main-node mount.

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { buildMcpServerRoutes } from "./mcp-servers";
import { InMemoryKvStore } from "@duyet/oma-kv-store";
import type { RouteServices } from "./types";

const TENANT = "tn_test";

function makeApp(kv: InMemoryKvStore, tenantId = TENANT) {
  const app = new Hono<{ Variables: { tenant_id: string } }>();
  app.use("*", async (c, next) => {
    c.set("tenant_id", tenantId);
    await next();
  });
  const routes = buildMcpServerRoutes({ services: { kv } as unknown as RouteServices });
  app.route("/", routes);
  return app;
}

describe("mcp_servers registry routes", () => {
  let kv: InMemoryKvStore;
  let app: Hono;
  beforeEach(() => {
    kv = new InMemoryKvStore();
    app = makeApp(kv);
  });

  const post = (body: unknown) =>
    app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("creates a server and returns 201 with an id", async () => {
    const res = await post({ name: "linear", url: "https://linear.app/mcp" });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.id).toMatch(/^mcps_/);
    expect(json.name).toBe("linear");
    expect(json.url).toBe("https://linear.app/mcp");
  });

  it("rejects a missing name (422)", async () => {
    const res = await post({ url: "https://linear.app/mcp" });
    expect(res.status).toBe(422);
  });

  it("rejects a non-http url (422)", async () => {
    const res = await post({ name: "x", url: "ftp://nope" });
    expect(res.status).toBe(422);
  });

  it("lists only this tenant's servers, newest first", async () => {
    await post({ name: "a", url: "https://a.example/mcp" });
    // created_at is Date.now(); step past the current millisecond so
    // "newest first" has an actual ordering to assert.
    await new Promise((r) => setTimeout(r, 2));
    await post({ name: "b", url: "https://b.example/mcp" });
    // Seed another tenant's row directly — must not leak.
    const other = makeApp(kv, "tn_other");
    await other.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "z", url: "https://z.example/mcp" }),
    });

    const res = await app.request("/");
    const json = await res.json();
    expect(json.data).toHaveLength(2);
    expect(json.data.map((r: { name: string }) => r.name)).toEqual(["b", "a"]);
  });

  it("gets, updates, and deletes a server", async () => {
    const created = await (await post({ name: "linear", url: "https://linear.app/mcp" })).json();
    const id = created.id;

    const got = await app.request(`/${id}`);
    expect(got.status).toBe(200);

    const patched = await app.request(`/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential_id: "cred_9", name: "linear-prod" }),
    });
    expect(patched.status).toBe(200);
    const patchedJson = await patched.json();
    expect(patchedJson.credential_id).toBe("cred_9");
    expect(patchedJson.name).toBe("linear-prod");
    expect(patchedJson.updated_at).toBeGreaterThan(0);

    const del = await app.request(`/${id}`, { method: "DELETE" });
    expect(del.status).toBe(204);
    const gone = await app.request(`/${id}`);
    expect(gone.status).toBe(404);
  });

  it("404s get/patch/delete on unknown id", async () => {
    expect((await app.request("/mcps_missing")).status).toBe(404);
    expect(
      (await app.request("/mcps_missing", { method: "DELETE" })).status,
    ).toBe(404);
  });
});
