/**
 * AnyRouter upstream provider routes — OAuth (PKCE) connect for the CF Worker.
 *
 * Mirrors the same routes in apps/main-node/src/index.ts (around line 1498).
 * The Node version also hot-swaps an in-process model provider on connect; the
 * CF Worker builds model clients per-request from D1 Model Cards, so the
 * hooks here are a no-op.
 *
 * Built lazily on first use because `buildAnyRouterRoutes` needs
 * deployment-specific config (publicOrigin, returnUrl) that comes from env
 * vars, which are only available at request time in the Workers runtime.
 */

import { Hono } from "hono";
import type { Env } from "@duyet/oma-shared";
import { buildAnyRouterRoutes } from "@duyet/oma-http-routes";

type Vars = { Bindings: Env; Variables: { tenant_id: string; user_id?: string; services: any } };

let cached: ReturnType<typeof buildAnyRouterRoutes> | null = null;

function build(c: any) {
  const env = c.env as Record<string, string | undefined>;
  const publicOrigin = (env.BETTER_AUTH_URL ?? `https://${c.req.header("host")}`).replace(/\/+$/, "");
  return buildAnyRouterRoutes({
    services: (ctx: any) => ctx.var.services,
    publicOrigin,
    returnUrl: `${publicOrigin}/model-cards`,
  });
}

const app = new Hono<Vars>();

// Mounted at /v1/providers/anyrouter — Hono strips the prefix before
// passing to this sub-app, so we see paths like /connect, /callback, etc.
// The inner routes from buildAnyRouterRoutes are at exactly those paths,
// so we forward using the already-stripped request URL.
app.all("*", async (c) => {
  const inner = cached ??= build(c);
  const url = new URL(c.req.raw.url);
  // Hono stripped the mount prefix from c.req.path, but c.req.raw.url
  // still has the original path. Forward the stripped path so the inner
  // router matches /connect, /callback, etc.
  const fwd = new Request(
    `${url.protocol}//${url.host}${c.req.path}${url.search}`,
    c.req.raw,
  );
  return inner.fetch(fwd);
});

export default app;
