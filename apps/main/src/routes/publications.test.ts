// Public-route auth-bypass scoping test (issue #72).
//
// Verifies the /p/:slug surface:
//   - visibility/status guardrails (private→404, draft→404, paused→403)
//   - ownership scoping: a session tagged with publication A's id is NOT
//     reachable via publication B's slug (returns 404).
//   - valid public sessions forward into the per-tenant session app.
//
// Uses fakes — no real D1, no real session routes.

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  buildPublicPublicationRoutes,
  gatePublicationState,
  renderWidgetScript,
  renderChatPage,
} from "./publications";
import type { PublicPublicationRoutesDeps } from "./publications";
import type { PublicationRow } from "@duyet/oma-publications-store";

function pubRow(overrides: Partial<PublicationRow> = {}): PublicationRow {
  return {
    id: "pub-1",
    tenant_id: "tenant-a",
    agent_id: "agent-1",
    agent_version: 2,
    slug: "duyetbot",
    title: "Duyetbot",
    description: null,
    avatar_url: null,
    visibility: "public",
    status: "live",
    greeting: null,
    suggested_prompts: [],
    pricing_ref: null,
    rate_limit_ref: null,
    environment_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// Simulated session ownership: sessionId → publication_id that owns it.
let sessionOwner: Record<string, string> = {};
let forwardedPaths: string[] = [];

function makeApp(pubResolver: (slug: string) => PublicationRow | Response) {
  const app = new Hono<{ Bindings: never }>();
  app.route(
    "/p",
    buildPublicPublicationRoutes({
      env: {} as never,
      servicesForTenant: (() => {}) as never,
      buildSessionsApp: () => {
        // Stub session app: records the forwarded path + returns 200.
        const inner = new Hono<{ Variables: { tenant_id: string } }>();
        inner.all("*", async (c) => {
          forwardedPaths.push(new URL(c.req.url).pathname);
          return c.json({ ok: true, path: new URL(c.req.url).pathname });
        });
        return Promise.resolve(inner) as never;
      },
      resolvePublication: (slug) => {
        const pub = pubResolver(slug);
        if (pub instanceof Response) return Promise.resolve(pub) as never;
        // Same guardrails the production caller (apps/main/src/index.ts)
        // enforces via the shared gatePublicationState helper (issue #210).
        const gate = gatePublicationState(pub);
        if (gate) return Promise.resolve(gate) as never;
        return Promise.resolve(pub) as never;
      },
      guardSessionCreate: () => Promise.resolve(null) as never,
      assertSessionOwnedByPublication: (pub, sessionId) =>
        Promise.resolve(sessionOwner[sessionId] === pub.id) as never,
    }),
  );
  return app;
}

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("public publication routes — guardrails + scoping", () => {
  beforeEach(() => {
    sessionOwner = {};
    forwardedPaths = [];
  });

  it("GET /p/:slug returns metadata for a live public publication", async () => {
    const app = makeApp(() => pubRow());
    const res = await app.request("/p/duyetbot");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slug: string; requires_auth: boolean };
    expect(body.slug).toBe("duyetbot");
    expect(body.requires_auth).toBe(false);
  });

  it("private publication → 404 (existence hidden)", async () => {
    const app = makeApp(() => pubRow({ visibility: "private" }));
    const res = await app.request("/p/duyetbot");
    expect(res.status).toBe(404);
  });

  it("draft publication → 404", async () => {
    const app = makeApp(() => pubRow({ status: "draft" }));
    const res = await app.request("/p/duyetbot");
    expect(res.status).toBe(404);
  });

  it("paused publication → 403", async () => {
    const app = makeApp(() => pubRow({ status: "paused" }));
    const res = await app.request("/p/duyetbot");
    expect(res.status).toBe(403);
  });

  it("unknown slug → 404", async () => {
    const app = makeApp(() => jsonRes(404, { error: "Not found" }));
    const res = await app.request("/p/missing");
    expect(res.status).toBe(404);
  });

  it("messages on a session owned by THIS publication forward to sessions app", async () => {
    sessionOwner["sess-x"] = "pub-1";
    const app = makeApp(() => pubRow());
    const res = await app.request("/p/duyetbot/sessions/sess-x/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hi" }),
    });
    expect(res.status).toBe(200);
    expect(forwardedPaths).toEqual(["/sessions/sess-x/messages"]);
  });

  it("messages on a session owned by ANOTHER publication → 404 (scope)", async () => {
    // sess-x belongs to pub-2, but the request is against pub-1's slug.
    sessionOwner["sess-x"] = "pub-2";
    const app = makeApp(() => pubRow());
    const res = await app.request("/p/duyetbot/sessions/sess-x/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hi" }),
    });
    expect(res.status).toBe(404);
    expect(forwardedPaths).toEqual([]);
  });

  it("SSE events/stream is ownership-scoped the same way", async () => {
    sessionOwner["sess-y"] = "pub-2";
    const app = makeApp(() => pubRow());
    const res = await app.request("/p/duyetbot/sessions/sess-y/events/stream");
    expect(res.status).toBe(404);
    expect(forwardedPaths).toEqual([]);
  });
});

describe("POST /:slug/sessions — environment forwarding (issue #225)", () => {
  // Fake agent rows: `runtime_binding` set means local-runtime (self-hosted,
  // no environment_id needed); absent means a cloud agent.
  const cloudAgent = { id: "agent-1" };
  const localRuntimeAgent = { id: "agent-1", runtime_binding: { type: "acp" } };

  function makeSessionCreateApp(opts: {
    agent: Record<string, unknown> | null;
    pub?: Partial<PublicationRow>;
  }) {
    let capturedBody: Record<string, unknown> | null = null;
    const app = new Hono<{ Bindings: never }>();
    app.route(
      "/p",
      buildPublicPublicationRoutes({
        env: {} as never,
        servicesForTenant: () =>
          Promise.resolve({
            agents: { get: async () => opts.agent },
          }) as never,
        buildSessionsApp: () => {
          const inner = new Hono();
          inner.post("/sessions", async (c) => {
            capturedBody = await c.req.json();
            return c.json({ id: "sess-new" });
          });
          return Promise.resolve(inner) as never;
        },
        resolvePublication: () => Promise.resolve(pubRow(opts.pub)) as never,
        guardSessionCreate: () => Promise.resolve(null) as never,
        assertSessionOwnedByPublication: () => Promise.resolve(true) as never,
      }),
    );
    return { app, getBody: () => capturedBody };
  }

  const post = (app: Hono<{ Bindings: never }>) =>
    app.request("/p/duyetbot/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

  it("forwards the publication's environment_id for a cloud agent", async () => {
    const { app, getBody } = makeSessionCreateApp({
      agent: cloudAgent,
      pub: { environment_id: "env-123" },
    });
    const res = await post(app);
    expect(res.status).toBe(200);
    expect(getBody()?.environment_id).toBe("env-123");
    expect((getBody()?.agent as { id: string }).id).toBe("agent-1");
  });

  it("409s with a clear message when a cloud agent's publication has no environment", async () => {
    const { app, getBody } = makeSessionCreateApp({
      agent: cloudAgent,
      pub: { environment_id: null },
    });
    const res = await post(app);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("environment_required");
    expect(body.error).toMatch(/environment/i);
    expect(getBody()).toBeNull(); // never forwarded to session-create
  });

  it("does not require environment_id for a local-runtime agent", async () => {
    const { app, getBody } = makeSessionCreateApp({
      agent: localRuntimeAgent,
      pub: { environment_id: null },
    });
    const res = await post(app);
    expect(res.status).toBe(200);
    expect(getBody()?.environment_id).toBeUndefined();
  });

  it("404s when the published agent no longer exists", async () => {
    const { app } = makeSessionCreateApp({ agent: null });
    const res = await post(app);
    expect(res.status).toBe(404);
  });
});

describe("public publication routes — paywall gate (issue #74)", () => {
  function makeGatedApp(gate: PublicPublicationRoutesDeps["enforcePaywall"]) {
    const app = new Hono<{ Bindings: never }>();
    app.route(
      "/p",
      buildPublicPublicationRoutes({
        env: {} as never,
        servicesForTenant: (() => {}) as never,
        buildSessionsApp: () => {
          const inner = new Hono();
          inner.all("*", async (c) => {
            forwardedPaths.push(new URL(c.req.url).pathname);
            return c.json({ ok: true });
          });
          return Promise.resolve(inner) as never;
        },
        resolvePublication: () => Promise.resolve(pubRow()) as never,
        guardSessionCreate: () => Promise.resolve(null) as never,
        assertSessionOwnedByPublication: () => Promise.resolve(true) as never,
        enforcePaywall: gate,
      }),
    );
    return app;
  }

  beforeEach(() => {
    forwardedPaths = [];
  });

  it("blocks a message with 402 when the wallet is short", async () => {
    const app = makeGatedApp(async () =>
      Response.json({ error: "Payment required", top_up_url: "/p/pay" }, { status: 402 }),
    );
    const res = await app.request("/p/duyetbot/sessions/s1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hi" }),
    });
    expect(res.status).toBe(402);
    expect(forwardedPaths).toEqual([]);
    const body = (await res.json()) as { top_up_url: string };
    expect(body.top_up_url).toBe("/p/pay");
  });

  it("forwards the message when the gate allows (free / paid-up)", async () => {
    const app = makeGatedApp(async () => null);
    const res = await app.request("/p/duyetbot/sessions/s1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hi" }),
    });
    expect(res.status).toBe(200);
    expect(forwardedPaths).toEqual(["/sessions/s1/messages"]);
  });

  it("passes the end-user identity from the bearer token", async () => {
    let seen = "";
    const app = makeGatedApp(async (opts) => {
      seen = opts.endUserId;
      return null;
    });
    await app.request("/p/duyetbot/sessions/s1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-123" },
      body: JSON.stringify({ content: "hi" }),
    });
    expect(seen).toBe("tok:tok-123");
  });
});

describe("embeddable widget.js (issue #75)", () => {
  it("serves JS for a live publication", async () => {
    const app = makeApp(() => pubRow());
    const res = await app.request("/p/duyetbot/widget.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/javascript");
    const body = await res.text();
    // Iframe target is the hosted chat page for this slug.
    expect(body).toContain('"/p/" + encodeURIComponent(SLUG)');
    expect(body).toContain('var SLUG = "duyetbot"');
  });

  it("returns the guardrail status as JS for a hidden publication", async () => {
    const app = makeApp(() => pubRow({ visibility: "private" }));
    const res = await app.request("/p/duyetbot/widget.js");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/javascript");
  });

  it("returns 403 JS for a paused publication", async () => {
    const app = makeApp(() => pubRow({ status: "paused" }));
    const res = await app.request("/p/duyetbot/widget.js");
    expect(res.status).toBe(403);
  });

  it("renderWidgetScript embeds slug/title as safe JSON literals", () => {
    const js = renderWidgetScript({ slug: "duyet-bot", title: 'He said "hi"' });
    // Quotes in the title are escaped by JSON.stringify — can't break the string.
    expect(js).toContain('var TITLE = "He said \\"hi\\""');
    // Load-once guard uses a sanitized identifier form of the slug.
    expect(js).toContain("__omaWidgetLoaded_duyet_bot");
  });
});

describe("hosted chat page — content negotiation (issue #178)", () => {
  const html = { accept: "text/html" };

  it("GET /p/:slug with Accept: text/html serves the hosted chat page", async () => {
    const app = makeApp(() => pubRow());
    const res = await app.request("/p/duyetbot", { headers: html });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("<!DOCTYPE html>");
    expect(body).toContain("Duyetbot");
    // The page drives the real public API flow: guest auth → session → messages.
    expect(body).toContain("/v1/public/auth/guest");
    expect(body).toContain('base + "/sessions"');
    expect(body).toContain("/messages");
  });

  it("GET /p/:slug with a non-HTML Accept still returns metadata JSON", async () => {
    const app = makeApp(() => pubRow());
    const res = await app.request("/p/duyetbot", {
      headers: { accept: "application/json" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { slug: string; requires_auth: boolean };
    expect(body.slug).toBe("duyetbot");
  });

  it("unknown slug with Accept: text/html → 404 HTML (not a chat)", async () => {
    const app = makeApp(() => jsonRes(404, { error: "Not found" }));
    const res = await app.request("/p/missing", { headers: html });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).not.toContain('id="oma-form"');
  });

  it("paused publication with Accept: text/html → 403 fail-closed HTML", async () => {
    const app = makeApp(() => pubRow({ status: "paused" }));
    const res = await app.request("/p/duyetbot", { headers: html });
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    // Fail-closed: a paused bot renders the guardrail page, never the composer.
    expect(body.toLowerCase()).toContain("paused");
    expect(body).not.toContain('id="oma-form"');
  });

  it("private publication with Accept: text/html → 404 (existence hidden)", async () => {
    const app = makeApp(() => pubRow({ visibility: "private" }));
    const res = await app.request("/p/duyetbot", { headers: html });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("renderChatPage escapes creator content and injects a safe config", () => {
    const page = renderChatPage(
      pubRow({
        title: 'Ada & "Friends" <script>',
        greeting: "Hi there!",
        suggested_prompts: ["What can you do?", "Tell me a joke"],
        avatar_url: "https://example.com/a.png",
      }),
    );
    // Creator-controlled title is HTML-escaped — the fake </script> can't break out.
    expect(page).toContain("Ada &amp; &quot;Friends&quot; &lt;script&gt;");
    expect(page).not.toContain('<script>Ada');
    // {id, slug} config injected for the client script.
    expect(page).toContain('"slug":"duyetbot"');
    expect(page).toContain('"id":"pub-1"');
    // Greeting + suggested prompts are server-rendered (progressive enhancement).
    expect(page).toContain("Hi there!");
    expect(page).toContain("What can you do?");
  });

  it("renderChatPage neutralises < in the injected config to prevent breakout", () => {
    const page = renderChatPage(pubRow({ slug: "a<b" }));
    expect(page).toContain('slug":"a\\u003cb');
    expect(page).not.toContain('slug":"a<b');
  });
});

describe("clickable magic-link landing page — GET /p/auth/verify (issue #215)", () => {
  function makeVerifyApp(verifyMagicLink: PublicPublicationRoutesDeps["verifyMagicLink"]) {
    const app = new Hono<{ Bindings: never }>();
    app.route(
      "/p",
      buildPublicPublicationRoutes({
        env: {} as never,
        servicesForTenant: (() => {}) as never,
        buildSessionsApp: (() => {}) as never,
        resolvePublication: (() => {}) as never,
        guardSessionCreate: () => Promise.resolve(null) as never,
        assertSessionOwnedByPublication: () => Promise.resolve(true) as never,
        verifyMagicLink,
      }),
    );
    return app;
  }

  it("valid token: stores the token under the chat page's exact localStorage key and redirects to /p/<slug>", async () => {
    const app = makeVerifyApp(async () => ({
      ok: true,
      session_token: "csess_abc",
      consumer_id: "cons_1",
      expires_at: "2026-01-01T00:00:00.000Z",
    }));
    const res = await app.request("/p/auth/verify?token=tok123&slug=duyetbot");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    // Same localStorage key convention as renderChatPage's TOK_KEY ("oma_pub_tok_" + slug).
    expect(body).toContain("localStorage.setItem(");
    expect(body).toContain('"oma_pub_tok_duyetbot"');
    expect(body).toContain('"csess_abc"');
    expect(body).toContain('window.location.replace("/p/duyetbot")');
  });

  it("invalid/expired token: renders a friendly error page with a back-to-chat pointer", async () => {
    const app = makeVerifyApp(async () => ({ ok: false, error: "Token expired", status: 401 }));
    const res = await app.request("/p/auth/verify?token=tok123&slug=duyetbot");
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Token expired");
    // "request a new link" pointer bounces back to the bot.
    expect(body).toContain('href="/p/duyetbot"');
    expect(body).toContain("Back to chat");
  });

  it("missing token or slug: 400 without calling verifyMagicLink", async () => {
    let called = false;
    const app = makeVerifyApp(async () => {
      called = true;
      return { ok: true, session_token: "x", consumer_id: "y", expires_at: "z" };
    });

    const noSlug = await app.request("/p/auth/verify?token=tok123");
    expect(noSlug.status).toBe(400);
    const noToken = await app.request("/p/auth/verify?slug=duyetbot");
    expect(noToken.status).toBe(400);
    expect(called).toBe(false);
  });

  it("renders a clear error instead of crashing when verifyMagicLink isn't wired up", async () => {
    const app = makeVerifyApp(undefined);
    const res = await app.request("/p/auth/verify?token=tok123&slug=duyetbot");
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("text/html");
  });
});
