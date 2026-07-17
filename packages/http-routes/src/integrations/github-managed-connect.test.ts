// Route-level coverage for the GitHub managed workspace "Connect" route
// (`GET /github/managed/connect`). It's a top-level browser navigation
// target: authenticated, forwards to the integrations gateway to mint the
// GitHub install URL, then 302-redirects the browser there. On no-managed-app
// (503) / error it 302s back to the console with a `managed_install` query.

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  buildIntegrationsRoutes,
  type IntegrationsBags,
  type InstallProxyForwarder,
} from "./index";

const USER = "user-a";
const RETURN_URL = "https://console.example.com/integrations/github";

function githubBag(): IntegrationsBags {
  return {
    linear: null,
    slack: null,
    // The connect route doesn't touch the repo bag, but a non-null github bag
    // is required so the provider isn't reported as unconfigured (503).
    github: { installations: {} as never, publications: {} as never },
  };
}

function buildApp(
  proxy: InstallProxyForwarder | null,
  opts: { userId?: string } = {},
) {
  const routes = buildIntegrationsRoutes({ bags: () => githubBag(), installProxy: proxy });
  const wrapper = new Hono<{ Variables: { tenant_id: string; user_id?: string } }>();
  wrapper.use("*", async (c, next) => {
    c.set("tenant_id", "tenant-a");
    if (opts.userId !== undefined) c.set("user_id", opts.userId);
    await next();
  });
  wrapper.route("/", routes);
  return wrapper;
}

describe("GitHub managed workspace connect route", () => {
  it("302-redirects the browser to the GitHub install URL the gateway mints", async () => {
    const calls: Array<{ subpath: string; body: unknown; needsInternalSecret: boolean }> = [];
    const proxy: InstallProxyForwarder = {
      async forward({ subpath, body, needsInternalSecret }) {
        calls.push({ subpath, body, needsInternalSecret });
        return new Response(
          JSON.stringify({ url: "https://github.com/apps/oma-managed-bot/installations/new?state=x" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    };
    const app = buildApp(proxy, { userId: USER });

    const res = await app.request(
      `/github/managed/connect?returnUrl=${encodeURIComponent(RETURN_URL)}`,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://github.com/apps/oma-managed-bot/installations/new?state=x",
    );
    // Forwarded to the gateway subpath with the resolved userId + returnUrl.
    expect(calls.length).toBe(1);
    expect(calls[0].subpath).toBe("github/managed/connect");
    expect(calls[0].needsInternalSecret).toBe(true);
    expect(calls[0].body).toEqual({ userId: USER, returnUrl: RETURN_URL });
  });

  it("redirects to the console with managed_install=unavailable when no managed App (503)", async () => {
    const proxy: InstallProxyForwarder = {
      async forward() {
        return new Response(JSON.stringify({ error: "managed_install_unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      },
    };
    const app = buildApp(proxy, { userId: USER });

    const res = await app.request(
      `/github/managed/connect?returnUrl=${encodeURIComponent(RETURN_URL)}`,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${RETURN_URL}?managed_install=unavailable`);
  });

  it("redirects with managed_install=error on a non-2xx (non-503) proxy failure", async () => {
    const proxy: InstallProxyForwarder = {
      async forward() {
        return new Response(JSON.stringify({ error: "boom" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      },
    };
    const app = buildApp(proxy, { userId: USER });

    const res = await app.request(
      `/github/managed/connect?returnUrl=${encodeURIComponent(RETURN_URL)}`,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${RETURN_URL}?managed_install=error`);
  });

  it("falls back to a relative console path when no returnUrl is supplied", async () => {
    const app = buildApp(null, { userId: USER });

    const res = await app.request("/github/managed/connect");

    expect(res.status).toBe(302);
    // installProxy=null → unavailable, relative fallback path.
    expect(res.headers.get("location")).toBe("/integrations/github?managed_install=unavailable");
  });

  it("rejects an unauthenticated request (no user_id) with 403", async () => {
    const proxy: InstallProxyForwarder = {
      async forward() {
        return new Response("{}", { status: 200 });
      },
    };
    const app = buildApp(proxy, {}); // no user_id set

    const res = await app.request("/github/managed/connect");

    expect(res.status).toBe(403);
  });
});
