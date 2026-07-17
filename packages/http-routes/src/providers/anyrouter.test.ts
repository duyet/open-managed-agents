// Route-level coverage for the AnyRouter connect flow's model-card bind
// (#136) — the "last mile" that turns a connected `sk-ar-…` key into a
// `model_cards` row an agent's `{"model": "anyrouter"}` resolves to.
//
// Exercises:
//   - First connect auto-mints a card (provider "oai", base_url from
//     @duyet/oma-anyrouter, model validated against the live catalog).
//   - Reconnect rotates the card's api_key in place — no duplicate row,
//     and a previously-picked `model` survives the rotation.
//   - Disconnect deletes the bound card.
//   - /status surfaces model_card_id + model once bound.
//   - A deployment with no model-cards store (self-host Node) no-ops
//     cleanly — connect/callback/disconnect all still succeed.

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { InMemoryKvStore } from "@duyet/oma-kv-store";
import { createInMemoryVaultService } from "@duyet/oma-vaults-store/test-fakes";
import { createInMemoryCredentialService } from "@duyet/oma-credentials-store/test-fakes";
import { createInMemoryModelCardService } from "@duyet/oma-model-cards-store/test-fakes";
import { ANYROUTER_API_BASE } from "@duyet/oma-anyrouter";
import { buildAnyRouterRoutes } from "./anyrouter";
import type { RouteServices, RouteServicesArg } from "../types";

const TENANT = "tenant-1";
const PUBLIC_ORIGIN = "https://oma.example.com";
const RETURN_URL = "https://console.example.com/model_cards";

/** Bare-minimum fetch stub for AnyRouter's DCR register + token exchange +
 *  models catalog endpoints. `modelsResponse` lets each test control what
 *  the catalog probe sees (used to exercise the default-model validation
 *  branches). */
function makeFetchImpl(
  opts: {
    modelsResponse?: Response | (() => Response);
    creditsResponse?: Response | (() => Response);
  } = {},
) {
  return async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.endsWith("/mcp/oauth/register")) {
      return new Response(
        JSON.stringify({
          client_id: "mcpc_test",
          client_name: "Open Managed Agents",
          redirect_uris: [`${PUBLIC_ORIGIN}/v1/providers/anyrouter/callback`],
        }),
        { status: 201 },
      );
    }
    if (u.endsWith("/mcp/oauth/token")) {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      // Distinguishable key per code so reconnect-rotation assertions can
      // tell the first and second mint apart.
      const key = `sk-ar-v1-${body.code ?? "unknown"}`;
      return new Response(
        JSON.stringify({ access_token: key, token_type: "Bearer", scope: "standard" }),
        { status: 200 },
      );
    }
    if (u.endsWith("/credits")) {
      const resp = opts.creditsResponse;
      if (typeof resp === "function") return resp();
      if (resp) return resp;
      return new Response(
        JSON.stringify({
          balance: 42.5,
          monthly_balance: 40,
          topup_balance: 2.5,
          used: 7.25,
          today_cost: 1.1,
          currency: "USD",
        }),
        { status: 200 },
      );
    }
    if (u.endsWith("/models")) {
      const resp = opts.modelsResponse;
      if (typeof resp === "function") return resp();
      if (resp) return resp;
      return new Response(JSON.stringify({ data: [{ id: "anthropic/claude-sonnet-4-6" }] }), {
        status: 200,
      });
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
}

function makeApp(opts: {
  withModelCards: boolean;
  modelsResponse?: Response | (() => Response);
  creditsResponse?: Response | (() => Response);
}) {
  const { service: vaults } = createInMemoryVaultService();
  const { service: credentials } = createInMemoryCredentialService();
  const { service: modelCards } = createInMemoryModelCardService();
  const kv = new InMemoryKvStore();

  const services: RouteServices = {
    vaults,
    credentials,
    kv,
    ...(opts.withModelCards ? { modelCards } : {}),
  } as unknown as RouteServices;

  const app = new Hono<{ Variables: { tenant_id: string } }>();
  app.use("*", async (c, next) => {
    c.set("tenant_id", TENANT);
    await next();
  });
  app.route(
    "/v1/providers/anyrouter",
    buildAnyRouterRoutes({
      services: services as unknown as RouteServicesArg,
      publicOrigin: PUBLIC_ORIGIN,
      returnUrl: RETURN_URL,
      fetchImpl: makeFetchImpl({
        modelsResponse: opts.modelsResponse,
        creditsResponse: opts.creditsResponse,
      }) as unknown as typeof fetch,
    }),
  );
  return { app, vaults, credentials, modelCards, kv };
}

/** Drives connect → callback for a fresh `code`, returning the callback's
 *  redirect Response. Reads the `state` param straight off the /connect
 *  redirect Location so the flow doesn't need a real browser. */
async function connectAndCallback(
  app: Hono<{ Variables: { tenant_id: string } }>,
  code: string,
) {
  const connectRes = await app.request("/v1/providers/anyrouter/connect");
  expect(connectRes.status).toBe(302);
  const location = new URL(connectRes.headers.get("location")!);
  const state = location.searchParams.get("state")!;
  expect(state).toBeTruthy();

  return app.request(
    `/v1/providers/anyrouter/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
  );
}

describe("buildAnyRouterRoutes — model card bind (#136)", () => {
  describe("with a model-cards store wired (Cloudflare)", () => {
    it("first connect mints a card bound to the connected key", async () => {
      const { app, modelCards } = makeApp({ withModelCards: true });

      const res = await connectAndCallback(app, "code-1");
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(`${RETURN_URL}?anyrouter_connected=1`);

      const card = await modelCards.findByModelId({ tenantId: TENANT, modelId: "anyrouter" });
      expect(card).not.toBeNull();
      expect(card!.provider).toBe("oai");
      expect(card!.base_url).toBe(ANYROUTER_API_BASE);
      expect(card!.model).toBe("anthropic/claude-sonnet-4-6");

      const apiKey = await modelCards.getApiKey({ tenantId: TENANT, cardId: card!.id });
      expect(apiKey).toBe("sk-ar-v1-code-1");
    });

    it("falls back to the catalog's first model when the default isn't listed", async () => {
      const { app, modelCards } = makeApp({
        withModelCards: true,
        modelsResponse: new Response(
          JSON.stringify({ data: [{ id: "openai/gpt-6-thinking" }, { id: "google/gemini-3-pro" }] }),
          { status: 200 },
        ),
      });

      await connectAndCallback(app, "code-1");

      const card = await modelCards.findByModelId({ tenantId: TENANT, modelId: "anyrouter" });
      expect(card!.model).toBe("openai/gpt-6-thinking");
    });

    it("falls back to the literal default when the catalog probe fails", async () => {
      const { app, modelCards } = makeApp({
        withModelCards: true,
        modelsResponse: new Response("upstream error", { status: 502 }),
      });

      await connectAndCallback(app, "code-1");

      const card = await modelCards.findByModelId({ tenantId: TENANT, modelId: "anyrouter" });
      expect(card!.model).toBe("anthropic/claude-sonnet-4-6");
    });

    it("reconnect rotates the same card's key without duplicating it or clobbering a picked model", async () => {
      const { app, modelCards } = makeApp({ withModelCards: true });

      await connectAndCallback(app, "code-1");
      const first = await modelCards.findByModelId({ tenantId: TENANT, modelId: "anyrouter" });
      expect(first).not.toBeNull();

      // Simulate the Console model picker (Phase 2) retargeting the card
      // before the key ever gets rotated.
      await modelCards.update({ tenantId: TENANT, cardId: first!.id, model: "openai/gpt-6-thinking" });

      const res = await connectAndCallback(app, "code-2");
      expect(res.status).toBe(302);

      const second = await modelCards.findByModelId({ tenantId: TENANT, modelId: "anyrouter" });
      expect(second!.id).toBe(first!.id); // same row, not a duplicate
      expect(second!.model).toBe("openai/gpt-6-thinking"); // picker choice survived rotation

      const apiKey = await modelCards.getApiKey({ tenantId: TENANT, cardId: second!.id });
      expect(apiKey).toBe("sk-ar-v1-code-2"); // key actually rotated
    });

    it("/status surfaces model_card_id + model once bound", async () => {
      const { app } = makeApp({ withModelCards: true });
      await connectAndCallback(app, "code-1");

      const res = await app.request("/v1/providers/anyrouter/status");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { connected: boolean; model_card_id?: string; model?: string };
      expect(body.connected).toBe(true);
      expect(body.model_card_id).toBeTruthy();
      expect(body.model).toBe("anthropic/claude-sonnet-4-6");
    });

    it("/status omits model_card_id + model before connecting", async () => {
      const { app } = makeApp({ withModelCards: true });
      const res = await app.request("/v1/providers/anyrouter/status");
      const body = await res.json();
      expect(body).toEqual({ connected: false });
    });

    it("disconnect deletes the bound card", async () => {
      const { app, modelCards } = makeApp({ withModelCards: true });
      await connectAndCallback(app, "code-1");
      const before = await modelCards.findByModelId({ tenantId: TENANT, modelId: "anyrouter" });
      expect(before).not.toBeNull();

      const res = await app.request("/v1/providers/anyrouter/disconnect", { method: "POST" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ disconnected: true });

      const after = await modelCards.findByModelId({ tenantId: TENANT, modelId: "anyrouter" });
      expect(after).toBeNull();
    });
  });

  describe("GET /models — presets", () => {
    it("passes presets through and serves them from cache", async () => {
      // A call-counting catalog stub: calls 1 (default-model probe on connect)
      // and 2 (the first real GET) succeed with presets; a 3rd call would 502.
      // So the second GET returning presets + cached:true proves it hit the
      // KV cache rather than re-fetching.
      let modelsCalls = 0;
      const modelsResponse = () => {
        modelsCalls += 1;
        if (modelsCalls >= 3) return new Response("upstream gone", { status: 502 });
        return new Response(
          JSON.stringify({
            data: [{ id: "anthropic/claude-sonnet-4-6" }],
            presets: [{ id: "pre_1", slug: "fast-coder", name: "Fast Coder" }],
          }),
          { status: 200 },
        );
      };
      const { app } = makeApp({ withModelCards: true, modelsResponse });
      await connectAndCallback(app, "code-1");

      const first = await app.request("/v1/providers/anyrouter/models");
      const firstBody = (await first.json()) as {
        data: { id: string }[];
        presets: { id: string; slug?: string; name?: string }[];
        cached?: boolean;
      };
      expect(firstBody.data.map((m) => m.id)).toEqual(["anthropic/claude-sonnet-4-6"]);
      expect(firstBody.presets).toHaveLength(1);
      expect(firstBody.presets[0].id).toBe("pre_1");
      expect(firstBody.presets[0].slug).toBe("fast-coder");
      expect(firstBody.cached).toBeUndefined();

      const second = await app.request("/v1/providers/anyrouter/models");
      const secondBody = (await second.json()) as {
        presets: { id: string }[];
        cached?: boolean;
      };
      expect(secondBody.cached).toBe(true);
      expect(secondBody.presets[0].id).toBe("pre_1");
    });

    it("an old-shape cache entry (no presets field) yields presets []", async () => {
      const { app, kv } = makeApp({ withModelCards: true });
      await kv.put(
        "anyrouter:models_cache",
        JSON.stringify({
          fetchedAt: Date.now(),
          models: [{ id: "openai/gpt-5", raw: { id: "openai/gpt-5" } }],
        }),
      );

      const res = await app.request("/v1/providers/anyrouter/models");
      const body = (await res.json()) as {
        data: { id: string }[];
        presets: unknown[];
        cached?: boolean;
      };
      expect(body.cached).toBe(true);
      expect(body.data).toHaveLength(1);
      expect(body.presets).toEqual([]);
    });
  });

  describe("GET /credits", () => {
    it("passes the balance fields through on a happy path", async () => {
      const { app } = makeApp({ withModelCards: true });
      await connectAndCallback(app, "code-1");

      const res = await app.request("/v1/providers/anyrouter/credits");
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({
        balance: 42.5,
        monthly_balance: 40,
        topup_balance: 2.5,
        used: 7.25,
        today_cost: 1.1,
        currency: "USD",
      });
      expect(body.cached).toBeUndefined();
    });

    it("returns { connect_required: true } when the tenant hasn't connected", async () => {
      const { app } = makeApp({ withModelCards: true });
      const res = await app.request("/v1/providers/anyrouter/credits");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ connect_required: true });
    });

    it("returns 502 when the upstream credits fetch fails", async () => {
      const { app } = makeApp({
        withModelCards: true,
        creditsResponse: new Response("upstream error", { status: 500 }),
      });
      await connectAndCallback(app, "code-1");

      const res = await app.request("/v1/providers/anyrouter/credits");
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("HTTP 500");
    });

    it("serves the balance from a per-tenant cache on the second call", async () => {
      // First credits call succeeds; a second upstream call would 502 — so the
      // second GET returning the balance + cached:true proves the KV cache hit.
      let creditsCalls = 0;
      const creditsResponse = () => {
        creditsCalls += 1;
        if (creditsCalls >= 2) return new Response("gone", { status: 502 });
        return new Response(
          JSON.stringify({
            balance: 42.5,
            monthly_balance: 40,
            topup_balance: 2.5,
            used: 7.25,
            today_cost: 1.1,
            currency: "USD",
          }),
          { status: 200 },
        );
      };
      const { app } = makeApp({ withModelCards: true, creditsResponse });
      await connectAndCallback(app, "code-1");

      const first = await app.request("/v1/providers/anyrouter/credits");
      expect(first.status).toBe(200);
      expect(((await first.json()) as { balance: number }).balance).toBe(42.5);

      const second = await app.request("/v1/providers/anyrouter/credits");
      expect(second.status).toBe(200);
      const body = (await second.json()) as { balance: number; cached?: boolean };
      expect(body.cached).toBe(true);
      expect(body.balance).toBe(42.5);
    });
  });

  describe("without a model-cards store (self-host Node)", () => {
    it("connect/callback/disconnect all still succeed with no card created", async () => {
      const { app } = makeApp({ withModelCards: false });

      const callbackRes = await connectAndCallback(app, "code-1");
      expect(callbackRes.status).toBe(302);
      expect(callbackRes.headers.get("location")).toBe(`${RETURN_URL}?anyrouter_connected=1`);

      const statusRes = await app.request("/v1/providers/anyrouter/status");
      const statusBody = (await statusRes.json()) as { connected: boolean; model_card_id?: string };
      expect(statusBody.connected).toBe(true);
      expect(statusBody.model_card_id).toBeUndefined();

      const disconnectRes = await app.request("/v1/providers/anyrouter/disconnect", { method: "POST" });
      expect(await disconnectRes.json()).toEqual({ disconnected: true });
    });
  });
});
