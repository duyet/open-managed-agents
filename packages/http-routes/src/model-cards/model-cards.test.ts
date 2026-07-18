// @ts-nocheck
// Route tests for /v1/model_cards — CRUD + cursor-paginated list, ported
// from apps/main/src/routes/model-cards.ts. Drives the Hono app directly
// against `createInMemoryModelCardService` (same fake both CF and Node
// route tests could use) via the shared `services` RouteServicesArg.

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { buildModelCardRoutes } from "./index";
import { createInMemoryModelCardService } from "@duyet/oma-model-cards-store/test-fakes";
import type { RouteServices } from "../types";

const TENANT = "tn_test";

function makeApp(modelCards: ReturnType<typeof createInMemoryModelCardService>["service"] | undefined) {
  const app = new Hono<{ Variables: { tenant_id: string } }>();
  app.use("*", async (c, next) => {
    c.set("tenant_id", TENANT);
    await next();
  });
  const routes = buildModelCardRoutes({
    services: { modelCards } as unknown as RouteServices,
  });
  app.route("/", routes);
  return app;
}

describe("model_cards routes", () => {
  let modelCards: ReturnType<typeof createInMemoryModelCardService>["service"];
  let app: Hono;

  beforeEach(() => {
    ({ service: modelCards } = createInMemoryModelCardService());
    app = makeApp(modelCards);
  });

  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("creates a card, returns 201 with a probe result for an unsupported provider", async () => {
    const res = await post("/", {
      model_id: "my-model",
      provider: "custom",
      api_key: "sk-xxx",
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.model_id).toBe("my-model");
    expect(json.model).toBe("my-model");
    expect(json.provider).toBe("custom");
    expect(json.api_key_preview).toBeTruthy();
    expect(json.is_default).toBe(false);
    // "custom" isn't ant/oai — probe is skipped, not attempted.
    expect(json.probe).toEqual({ ok: null, reason: "unsupported_provider" });
  });

  it("rejects a create missing required fields (400)", async () => {
    const res = await post("/", { provider: "custom" });
    expect(res.status).toBe(400);
  });

  it("rejects a duplicate model_id (409)", async () => {
    await post("/", { model_id: "dup", provider: "custom", api_key: "sk-1" });
    const res = await post("/", { model_id: "dup", provider: "custom", api_key: "sk-2" });
    expect(res.status).toBe(409);
  });

  it("gets, updates, and deletes a card", async () => {
    const created = await (
      await post("/", { model_id: "gud", provider: "custom", api_key: "sk-1" })
    ).json();

    const got = await app.request(`/${created.id}`);
    expect(got.status).toBe(200);

    const updated = await post(`/${created.id}`, { model_id: "gud-renamed" });
    expect(updated.status).toBe(200);
    const updatedJson = await updated.json();
    expect(updatedJson.model_id).toBe("gud-renamed");

    const del = await app.request(`/${created.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const gone = await app.request(`/${created.id}`);
    expect(gone.status).toBe(404);
  });

  it("404s update/delete on unknown id", async () => {
    expect((await post("/mc_missing", { model_id: "x" })).status).toBe(404);
    expect((await app.request("/mc_missing", { method: "DELETE" })).status).toBe(404);
  });

  it("lists cards for the tenant, newest first, cursor-paginated", async () => {
    await post("/", { model_id: "a", provider: "custom", api_key: "sk-a" });
    await new Promise((r) => setTimeout(r, 2));
    await post("/", { model_id: "b", provider: "custom", api_key: "sk-b" });

    const res = await app.request("/");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.map((c: { model_id: string }) => c.model_id)).toEqual(["b", "a"]);
  });

  it("rejects an unknown provider filter (400)", async () => {
    const res = await app.request("/?provider=nope");
    expect(res.status).toBe(400);
  });

  it("rejects an unparseable created_after (400)", async () => {
    const res = await app.request("/?created_after=not-a-date");
    expect(res.status).toBe(400);
  });

  it("GET /:id/key returns the decrypted api_key", async () => {
    const created = await (
      await post("/", { model_id: "keyed", provider: "custom", api_key: "sk-secret" })
    ).json();
    const res = await app.request(`/${created.id}/key`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.api_key).toBe("sk-secret");
  });

  it("404s /:id/key for an unknown id", async () => {
    const res = await app.request("/mc_missing/key");
    expect(res.status).toBe(404);
  });

  it("501s every route when modelCards service is unconfigured", async () => {
    const bareApp = makeApp(undefined);
    expect((await bareApp.request("/")).status).toBe(501);
    expect(
      (
        await bareApp.request("/", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model_id: "x", provider: "custom", api_key: "k" }),
        })
      ).status,
    ).toBe(501);
    expect((await bareApp.request("/mc_x")).status).toBe(501);
  });
});
