// @ts-nocheck
// Route tests for the tenant-level MCP server registry (Issue #91 Phase 3).
// Drives the Hono app directly with an in-memory KV, a wrapper middleware
// standing in for the auth layer that sets tenant_id + services.

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import mcpServersRoutes from "./mcp-servers";
import { InMemoryKvStore } from "@duyet/oma-kv-store";

const TENANT = "tn_test";

function makeApp(kv: InMemoryKvStore, tenantId = TENANT) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("tenant_id" as never, tenantId as never);
    c.set("services" as never, { kv } as never);
    await next();
  });
  app.route("/", mcpServersRoutes);
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
