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
    env: Env,
  ) => Promise<{ fetch(req: Request, env?: unknown, ctx?: unknown): Promise<Response> | Response }>;
  /** Resolve + guardrail a publication by slug. Returns the row or a
   *  Response when the slug is hidden/forbidden. */
  resolvePublication: (slug: string, env: Env) => Promise<PublicationRow | Response>;
  /** Anti-abuse gates on session create. Returns a Response to reject. */
  guardSessionCreate: (opts: {
    publication: PublicationRow;
    ip: string;
    env: Env;
  }) => Promise<Response | null>;
  /** Verify a session belongs to this publication (ownership scope). */
  assertSessionOwnedByPublication: (
    publication: PublicationRow,
    sessionId: string,
    env: Env,
  ) => Promise<boolean>;
  /** Paywall gate for a public message (issue #74). Returns a 402 Response to
   *  block (insufficient credits / no subscription), or null to allow. When
   *  omitted, or when the publication is free / payments disabled, the surface
   *  is ungated. `endUserId` identifies the wallet (consumer token or IP). */
  enforcePaywall?: (opts: {
    publication: PublicationRow;
    endUserId: string;
    sessionId: string;
    env: Env;
  }) => Promise<Response | null>;
  /** Resolve the wallet identity for the paywall from the request (issue #73).
   *  When a consumer bearer token maps to a signed-in end-user, this returns a
   *  stable `eu:<consumer_id>` id so the wallet survives token refresh AND the
   *  guest -> email upgrade (same consumer id). When omitted or unresolved, the
   *  surface falls back to the built-in `tok:<token>` / `ip:<ip>` scheme. */
  resolveEndUserId?: (req: Request, env: Env) => Promise<string>;
}

const DEFAULT_PUBLIC_SESSION_CAP_PER_SLUG = 50;
const DEFAULT_PUBLIC_SESSION_CAP_PER_IP = 20;

export function buildPublicPublicationRoutes(deps: PublicPublicationRoutesDeps) {
  const app = new Hono<{ Bindings: Env }>();

  // GET /p/:slug — publication metadata (no auth).
  app.get("/:slug", async (c) => {
    const resolved = await deps.resolvePublication(c.req.param("slug"), c.env);
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

  // GET /p/:slug/widget.js — self-contained embed script (issue #75).
  //
  // A creator drops `<script src="https://host/p/<slug>/widget.js"></script>`
  // on any third-party page. The script injects a floating launcher bubble
  // that toggles an iframe of the hosted chat page (/p/:slug). No framework
  // dependency on the embedder's side. Guardrails mirror the metadata route:
  // a hidden/paused publication never ships a working widget.
  app.get("/:slug/widget.js", async (c) => {
    const resolved = await deps.resolvePublication(c.req.param("slug"), c.env);
    if (resolved instanceof Response) {
      // Return the guardrail status but as JS so the <script> tag fails
      // quietly (a JSON body would throw a SyntaxError in the console).
      return new Response(
        `/* Open Managed Agents: publication unavailable (${resolved.status}). */`,
        {
          status: resolved.status,
          headers: {
            "content-type": "application/javascript; charset=utf-8",
            "cache-control": "public, max-age=60",
          },
        },
      );
    }
    const pub = resolved;
    const js = renderWidgetScript({
      slug: pub.slug,
      title: pub.title,
    });
    return new Response(js, {
      headers: {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "public, max-age=300",
      },
    });
  });

  // POST /p/:slug/sessions — create a session bound to the published
  // agent+version, owned by the publication's tenant, tagged publication_id.
  app.post("/:slug/sessions", async (c) => {
    const resolved = await deps.resolvePublication(c.req.param("slug"), c.env);
    if (resolved instanceof Response) return resolved;
    const pub = resolved;

    const ip = clientIp(c.req.raw);
    const gate = await deps.guardSessionCreate({ publication: pub, ip, env: c.env });
    if (gate) return gate;

    const services = await deps.servicesForTenant(pub.tenant_id);
    // Agent exists + version pin respected by the session-create path.
    const agent = await services.agents.get({
      tenantId: pub.tenant_id,
      agentId: pub.agent_id,
    });
    if (!agent) return c.json({ error: "Published agent not found" }, 404);

    // Bind the wallet identity to the session at create so the post-turn
    // per_1k_tokens metering hook (agent DO, issue #74/#163) can resolve which
    // wallet to debit — the DO can't recompute it from the request. Same
    // resolver the paywall gate uses. Also unblocks notify-dispatch /
    // consumer-admin, which already read metadata.end_user_id.
    const endUserId = deps.resolveEndUserId
      ? await deps.resolveEndUserId(c.req.raw, c.env)
      : endUserIdFor(c.req.raw);

    // Forward the create into the per-tenant session app, but rewrite the
    // body to pin the published agent + version + the publication tag.
    const forwarded = await forwardToSessions(c, pub.tenant_id, () => {
      return deps.buildSessionsApp(pub.tenant_id, c.env);
    }, async (body) => {
      return {
        ...body,
        agent: { id: pub.agent_id, version: pub.agent_version },
        metadata: {
          ...(body.metadata ?? {}),
          publication_id: pub.id,
          end_user_id: endUserId,
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
    // Paywall gate (issue #74) — runs before the message reaches the agent.
    // free / payments-disabled publications pass straight through.
    if (deps.enforcePaywall) {
      const endUserId = deps.resolveEndUserId
        ? await deps.resolveEndUserId(c.req.raw, c.env)
        : endUserIdFor(c.req.raw);
      const gate = await deps.enforcePaywall({
        publication: pub,
        endUserId,
        sessionId: c.req.param("id") ?? "",
        env: c.env,
      });
      if (gate) return gate;
    }
    return forwardToSessions(c, pub.tenant_id, () => deps.buildSessionsApp(pub.tenant_id, c.env));
  });

  // GET /p/:slug/sessions/:id/events/stream — SSE pass-through (scoped).
  app.get("/:slug/sessions/:id/events/stream", async (c) => {
    const scoped = await scopedSession(c, deps);
    if (scoped instanceof Response) return scoped;
    const { pub } = scoped;
    return forwardToSessions(c, pub.tenant_id, () => deps.buildSessionsApp(pub.tenant_id, c.env));
  });

  // GET /p/:slug/sessions/:id/events — JSON events pass-through (scoped).
  app.get("/:slug/sessions/:id/events", async (c) => {
    const scoped = await scopedSession(c, deps);
    if (scoped instanceof Response) return scoped;
    const { pub } = scoped;
    return forwardToSessions(c, pub.tenant_id, () => deps.buildSessionsApp(pub.tenant_id, c.env));
  });

  return app;
}

/** Resolve the publication + assert the request's session belongs to it. */
async function scopedSession(
  c: import("hono").Context,
  deps: PublicPublicationRoutesDeps,
): Promise<{ pub: PublicationRow } | Response> {
  const slug = c.req.param("slug");
  if (!slug) return c.json({ error: "Publication slug required" }, 400);
  const resolved = await deps.resolvePublication(slug, c.env);
  if (resolved instanceof Response) return resolved;
  const pub = resolved;
  const sessionId = c.req.param("id");
  if (!sessionId) return c.json({ error: "Session id required" }, 400);
  const owned = await deps.assertSessionOwnedByPublication(pub, sessionId, c.env);
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
  buildApp: () => Promise<{ fetch(req: Request, env?: unknown, ctx?: unknown): Promise<Response> | Response }>,
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
  // `c.executionCtx` is only present under a real CF request context;
  // under a plain `app.request()` (tests) the getter throws, so read it
  // defensively. The inner session app tolerates an absent ctx.
  let executionCtx: unknown;
  try {
    executionCtx = c.executionCtx;
  } catch {
    executionCtx = undefined;
  }
  return app.fetch(
    new Request(url, {
      method: c.req.method,
      headers,
      body,
    }),
    c.env,
    executionCtx,
  );
}

/** Wallet identity for the paywall: the consumer bearer token when present
 *  (a signed-in end-user), else a stable per-IP anonymous id. Charging an
 *  anonymous IP wallet is fine — the ledger is keyed by this opaque id. */
function endUserIdFor(req: Request): string {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return `tok:${auth.slice(7)}`;
  return `ip:${clientIp(req)}`;
}

/**
 * Build the embeddable widget bootstrap script for a publication. The script
 * is fully self-contained (no external deps) and derives its own origin from
 * the currently-executing <script> tag, so the same bytes work regardless of
 * which host serves them. It renders a launcher bubble that toggles an iframe
 * pointing at the hosted chat page (/p/<slug>).
 *
 * `slug` and `title` are injected as JSON literals so quotes/backslashes in a
 * title can't break out of the string or inject markup.
 */
export function renderWidgetScript(opts: { slug: string; title: string }): string {
  const slug = JSON.stringify(opts.slug);
  const title = JSON.stringify(opts.title);
  return `(function () {
  "use strict";
  var SLUG = ${slug};
  var TITLE = ${title};
  if (window.__omaWidgetLoaded_${sanitizeIdent(opts.slug)}) return;
  window.__omaWidgetLoaded_${sanitizeIdent(opts.slug)} = true;

  // Derive the serving origin from this script's own URL.
  var current = document.currentScript;
  var origin;
  try {
    origin = new URL(current.src).origin;
  } catch (e) {
    origin = window.location.origin;
  }
  var chatUrl = origin + "/p/" + encodeURIComponent(SLUG);

  var Z = 2147483000;
  var open = false;

  var frame = document.createElement("iframe");
  frame.title = TITLE;
  frame.src = chatUrl;
  frame.setAttribute("allow", "clipboard-write");
  frame.style.cssText = [
    "position:fixed", "bottom:88px", "right:20px",
    "width:min(400px, calc(100vw - 40px))",
    "height:min(600px, calc(100vh - 120px))",
    "border:0", "border-radius:16px",
    "box-shadow:0 12px 48px rgba(0,0,0,0.24)",
    "z-index:" + Z, "background:#fff",
    "display:none", "overflow:hidden"
  ].join(";");

  var button = document.createElement("button");
  button.type = "button";
  button.setAttribute("aria-label", "Open " + TITLE + " chat");
  button.style.cssText = [
    "position:fixed", "bottom:20px", "right:20px",
    "width:56px", "height:56px", "border:0", "border-radius:50%",
    "cursor:pointer", "background:#5b5bd6",
    "color:#fff", "font-size:26px", "line-height:56px", "text-align:center",
    "box-shadow:0 6px 20px rgba(0,0,0,0.28)", "z-index:" + (Z + 1),
    "transition:transform 0.15s ease"
  ].join(";");
  button.textContent = "\\uD83D\\uDCAC";

  function setOpen(next) {
    open = next;
    frame.style.display = open ? "block" : "none";
    button.textContent = open ? "\\u2715" : "\\uD83D\\uDCAC";
    button.setAttribute("aria-expanded", open ? "true" : "false");
  }
  button.addEventListener("click", function () { setOpen(!open); });

  function mount() {
    document.body.appendChild(frame);
    document.body.appendChild(button);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
`;
}

/** Turn a slug into a safe JS identifier fragment for the load-once guard. */
function sanitizeIdent(slug: string): string {
  return slug.replace(/[^a-zA-Z0-9_]/g, "_");
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
