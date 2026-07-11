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
import { buildPublicPublicationRoutes } from "./index";
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
      resolvePublication: (slug) => Promise.resolve(pubResolver(slug)) as never,
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
    const body = await res.json();
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
