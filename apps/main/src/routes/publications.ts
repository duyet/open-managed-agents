// Public chat surface for published agents (issue #72).
//
// Distinct route group mounted at /p/:slug/* that BYPASSES tenant
// x-api-key auth (see apps/main/src/auth.ts — /p/* is an explicit
// bypass alongside /health, /auth/*, /v1/internal/*). Each request
// resolves the owning {tenant_id, agent_id, agent_version} from the
// publication row itself, then forwards into the existing per-tenant
// session routes so the public surface inherits all the normal session
// create / message / SSE behavior (no logic fork).
//
// TODO(#75): hosted chat page UI — render a working conversation against a
// live publication at /p/:slug. For now only the JSON + SSE API surface
// exists; non-tech users get a working link once the page ships.
//
// Guardrails baked in from day one (anti-abuse floor before consumer
// auth #2):
//   - private  → 404 (don't reveal existence)
//   - draft    → 404 (never published)
//   - paused   → 403
//   - public / unlisted → reachable (unlisted only by direct slug)
//   - per-slug + per-IP session cap (KV counters)
//   - per-IP rate-limit on session create
//   - ownership scoping: a session created against publication A is not
//     reachable via publication B's slug (metadata.publication_id check).

import { Hono } from "hono";
import type { Env } from "@duyet/oma-shared";
import type { Services } from "@duyet/oma-services";
import type { PublicationRow } from "@duyet/oma-publications-store";

export interface PublicPublicationRoutesDeps {
  env: Env;
  /** Resolve the per-tenant Services container for the publication's
   *  tenant (so the forwarded session routes read/write the right DB). */
  servicesForTenant: (tenantId: string) => Promise<Services>;
  /** Build the per-tenant session app (mirrors the /v1/sessions mount). */
  buildSessionsApp: (
    tenantId: string,
  ) => Promise<{ fetch(req: Request, env?: unknown, ctx?: unknown): Promise<Response> }>;
  /** Resolve + guardrail a publication by slug. Returns the row or a
   *  Response when the slug is hidden/forbidden. */
  resolvePublication: (slug: string) => Promise<PublicationRow | Response>;
  /** Anti-abuse gates on session create. Returns a Response to reject. */
  guardSessionCreate: (opts: {
    publication: PublicationRow;
    ip: string;
  }) => Promise<Response | null>;
  /** Verify a session belongs to this publication (ownership scope). */
  assertSessionOwnedByPublication: (
    publication: PublicationRow,
    sessionId: string,
  ) => Promise<boolean>;
}

const DEFAULT_PUBLIC_SESSION_CAP_PER_SLUG = 50;
const DEFAULT_PUBLIC_SESSION_CAP_PER_IP = 20;

export function buildPublicPublicationRoutes(deps: PublicPublicationRoutesDeps) {
  const app = new Hono<{ Bindings: Env }>();

  // GET /p/:slug — publication metadata (no auth).
  app.get("/:slug", async (c) => {
    const resolved = await deps.resolvePublication(c.req.param("slug"));
    if (resolved instanceof Response) return resolved;
    const pub = resolved;
    return c.json({
      id: pub.id,
      slug: pub.slug,
      title: pub.title,
      description: pub.description,
      avatar_url: pub.avatar_url,
      greeting: pub.greeting,
      suggested_prompts: pub.suggested_prompts,
      visibility: pub.visibility,
      status: pub.status,
      // Signals the (future) consumer-auth / paywall surface what the
      // client should gate on. pricing_ref null today → no auth/credits.
      requires_auth: false,
      requires_credits: false,
    });
  });

  // POST /p/:slug/sessions — create a session bound to the published
  // agent+version, owned by the publication's tenant, tagged publication_id.
  app.post("/:slug/sessions", async (c) => {
    const resolved = await deps.resolvePublication(c.req.param("slug"));
    if (resolved instanceof Response) return resolved;
    const pub = resolved;

    const ip = clientIp(c.req.raw);
    const gate = await deps.guardSessionCreate({ publication: pub, ip });
    if (gate) return gate;

    const services = await deps.servicesForTenant(pub.tenant_id);
    // Agent exists + version pin respected by the session-create path.
    const agent = await services.agents.get({
      tenantId: pub.tenant_id,
      agentId: pub.agent_id,
    });
    if (!agent) return c.json({ error: "Published agent not found" }, 404);

    // Forward the create into the per-tenant session app, but rewrite the
    // body to pin the published agent + version + the publication tag.
    const forwarded = await forwardToSessions(c, pub.tenant_id, () => {
      return deps.buildSessionsApp(pub.tenant_id);
    }, async (body) => {
      return {
        ...body,
        agent: { id: pub.agent_id, version: pub.agent_version },
        metadata: {
          ...(body.metadata ?? {}),
          publication_id: pub.id,
        },
      };
    });
    return forwarded;
  });

  // POST /p/:slug/sessions/:id/messages — pass-through (ownership-scoped).
  app.post("/:slug/sessions/:id/messages", async (c) => {
    const scoped = await scopedSession(c, deps);
    if (scoped instanceof Response) return scoped;
    const { pub } = scoped;
    return forwardToSessions(c, pub.tenant_id, () => deps.buildSessionsApp(pub.tenant_id));
  });

  // GET /p/:slug/sessions/:id/events/stream — SSE pass-through (scoped).
  app.get("/:slug/sessions/:id/events/stream", async (c) => {
    const scoped = await scopedSession(c, deps);
    if (scoped instanceof Response) return scoped;
    const { pub } = scoped;
    return forwardToSessions(c, pub.tenant_id, () => deps.buildSessionsApp(pub.tenant_id));
  });

  // GET /p/:slug/sessions/:id/events — JSON events pass-through (scoped).
  app.get("/:slug/sessions/:id/events", async (c) => {
    const scoped = await scopedSession(c, deps);
    if (scoped instanceof Response) return scoped;
    const { pub } = scoped;
    return forwardToSessions(c, pub.tenant_id, () => deps.buildSessionsApp(pub.tenant_id));
  });

  return app;
}

/** Resolve the publication + assert the request's session belongs to it. */
async function scopedSession(
  c: import("hono").Context,
  deps: PublicPublicationRoutesDeps,
): Promise<{ pub: PublicationRow } | Response> {
  const resolved = await deps.resolvePublication(c.req.param("slug"));
  if (resolved instanceof Response) return resolved;
  const pub = resolved;
  const sessionId = c.req.param("id");
  const owned = await deps.assertSessionOwnedByPublication(pub, sessionId);
  if (!owned) return c.json({ error: "Session not found" }, 404);
  return { pub };
}

/**
 * Forward the outer Hono request into the per-tenant session app, injecting
 * the resolved tenant_id via header (mirrors apps/main/src/index.ts
 * invokePackage) and stripping the /p/:slug prefix down to the session path
 * the inner app expects (e.g. /sessions/:id/messages).
 */
async function forwardToSessions(
  c: import("hono").Context,
  tenantId: string,
  buildApp: () => Promise<{ fetch(req: Request, env?: unknown, ctx?: unknown): Promise<Response> }>,
  rewriteBody?: (body: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>,
): Promise<Response> {
  const url = new URL(c.req.url);
  // Path under /p/:slug is e.g. /sessions or /sessions/:id/messages.
  const stripped = url.pathname.replace(/^\/p\/[^/]+/, "") || "/";
  url.pathname = stripped;

  const headers = new Headers(c.req.raw.headers);
  headers.set("x-oma-internal-tenant-id", tenantId);

  let body: BodyInit | null = null;
  if (!["GET", "HEAD"].includes(c.req.method)) {
    const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const next = rewriteBody ? await rewriteBody(raw) : raw;
    body = JSON.stringify(next);
    if (body) headers.set("content-type", "application/json");
  }

  const app = await buildApp();
  return app.fetch(
    new Request(url, {
      method: c.req.method,
      headers,
      body,
    }),
    c.env,
    c.executionCtx,
  );
}

function clientIp(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "anonymous"
  );
}

/** Per-slug + per-IP KV session caps. Keyed on the publication tenant's KV. */
export async function publicSessionCaps(
  kv: import("@duyet/oma-kv-store").KvStore,
  env: Env,
  opts: { slug: string; ip: string; today: string },
): Promise<Response | null> {
  const slugCap = Number(env.PUBLIC_SESSION_CAP_PER_SLUG ?? DEFAULT_PUBLIC_SESSION_CAP_PER_SLUG);
  const ipCap = Number(env.PUBLIC_SESSION_CAP_PER_IP ?? DEFAULT_PUBLIC_SESSION_CAP_PER_IP);
  const slugKey = `pub:sessions:slug:${opts.slug}:${opts.today}`;
  const ipKey = `pub:sessions:ip:${opts.ip}:${opts.today}`;
  for (const [key, cap] of [
    [slugKey, slugCap],
    [ipKey, ipCap],
  ] as const) {
    if (cap <= 0) continue;
    const raw = await kv.get(key);
    const current = raw ? Number(raw) : 0;
    if (current >= cap) {
      return Response.json(
        { error: "Session creation rate limit reached for this link. Try again later." },
        { status: 429 },
      );
    }
    await kv.put(key, String(current + 1), { expirationTtl: 25 * 3600 });
  }
  return null;
}
