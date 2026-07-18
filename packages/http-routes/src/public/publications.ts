// Public chat surface for published agents (issue #72).
//
// Runtime-neutral factory shared by both control planes — the Cloudflare
// worker (apps/main) and the self-host Node server (apps/main-node) — so the
// hosted chat page, widget, and public session/message pass-throughs render
// and behave identically on both (issue #226). Each runtime supplies the
// small `deps` bundle below (publication resolution, per-tenant session app,
// paywall gate, …); this file owns everything above that seam.
//
// Distinct route group mounted at /p/:slug/* that BYPASSES tenant
// x-api-key auth (on CF see apps/main/src/auth.ts — /p/* is an explicit
// bypass alongside /health, /auth/*, /v1/internal/*). Each request
// resolves the owning {tenant_id, agent_id, agent_version} from the
// publication row itself, then forwards into the existing per-tenant
// session routes so the public surface inherits all the normal session
// create / message / SSE behavior (no logic fork).
//
// GET /p/:slug is content-negotiated (issue #178): `Accept: text/html` (a
// browser or the embed widget's iframe) gets the self-contained hosted chat
// page (renderChatPage, below); API clients keep the metadata JSON.
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
//   - environment required (issue #225): a publication with no environment_id
//     set 409s session-create with a clear message instead of forwarding
//     into the raw "environment_id is required" 400 session-create would
//     otherwise return. environment_id is unconditionally required on every
//     session now (harness-to-environment migration) — there's no more
//     "local-runtime agents don't need one" carve-out.

import { Hono } from "hono";
import type { PublicationRow } from "@duyet/oma-publications-store";

/** Ambient env is opaque to the factory — it only ever hands it straight back
 *  to the runtime-supplied `deps` callbacks — so it's typed as a loose record.
 *  Node passes `process.env` (index-signatured → assignable); CF passes its
 *  `Env` interface via the `as never` casts already at that call site. */
export type PublicEnv = Record<string, unknown>;

/** The only ambient env `publicSessionCaps` actually reads. Kept structural
 *  (no index signature) so CF's `Env` interface is directly assignable without
 *  a cast — that's the one spot a runtime hands its real env straight in. */
export interface PublicSessionCapsEnv {
  PUBLIC_SESSION_CAP_PER_SLUG?: unknown;
  PUBLIC_SESSION_CAP_PER_IP?: unknown;
}

/** Minimal slice of the per-tenant services container the public surface
 *  needs: just enough to confirm the published agent exists. Both CF
 *  `Services` and Node `RouteServices` satisfy it. */
export interface PublicPublicationServices {
  agents: {
    get(args: {
      tenantId: string;
      agentId: string;
    }): Promise<Record<string, unknown> | null>;
  };
}

export interface PublicPublicationRoutesDeps {
  /** Vestigial — the factory reads ambient env off the Hono context, not this
   *  field. Kept optional for call-site compatibility. */
  env?: PublicEnv;
  /** Resolve the per-tenant Services container for the publication's
   *  tenant (so the forwarded session routes read/write the right DB). */
  servicesForTenant: (tenantId: string) => Promise<PublicPublicationServices>;
  /** Build the per-tenant session app (mirrors the /v1/sessions mount). */
  buildSessionsApp: (
    tenantId: string,
    env: PublicEnv,
  ) => Promise<{ fetch(req: Request, env?: unknown, ctx?: unknown): Promise<Response> | Response }>;
  /** Resolve + guardrail a publication by slug. Returns the row or a
   *  Response when the slug is hidden/forbidden. */
  resolvePublication: (slug: string, env: PublicEnv) => Promise<PublicationRow | Response>;
  /** Anti-abuse gates on session create. Returns a Response to reject. */
  guardSessionCreate: (opts: {
    publication: PublicationRow;
    ip: string;
    env: PublicEnv;
  }) => Promise<Response | null>;
  /** Verify a session belongs to this publication (ownership scope). */
  assertSessionOwnedByPublication: (
    publication: PublicationRow,
    sessionId: string,
    env: PublicEnv,
  ) => Promise<boolean>;
  /** Paywall gate for a public message (issue #74). Returns a 402 Response to
   *  block (insufficient credits / no subscription), or null to allow. When
   *  omitted, or when the publication is free / payments disabled, the surface
   *  is ungated. `endUserId` identifies the wallet (consumer token or IP). */
  enforcePaywall?: (opts: {
    publication: PublicationRow;
    endUserId: string;
    sessionId: string;
    env: PublicEnv;
  }) => Promise<Response | null>;
  /** Resolve the wallet identity for the paywall from the request (issue #73).
   *  When a consumer bearer token maps to a signed-in end-user, this returns a
   *  stable `eu:<consumer_id>` id so the wallet survives token refresh AND the
   *  guest -> email upgrade (same consumer id). When omitted or unresolved, the
   *  surface falls back to the built-in `tok:<token>` / `ip:<ip>` scheme. */
  resolveEndUserId?: (req: Request, env: PublicEnv) => Promise<string>;
  /** Exchange a magic-link token for a consumer session — the clickable
   *  landing page (GET /auth/verify, issue #215) shares this with
   *  POST /v1/public/auth/verify (consumer-auth.ts's verifyMagicLinkToken)
   *  instead of duplicating the query/expiry/issue-session logic. Optional
   *  so existing fixtures/tests that don't exercise the landing page don't
   *  need to wire it up. */
  verifyMagicLink?: (
    token: string,
    env: PublicEnv,
  ) => Promise<
    | { ok: true; session_token: string; consumer_id: string; expires_at: string }
    | { ok: false; error: string; status: number }
  >;
}

/**
 * Gate a resolved publication row on its visibility/status before any
 * public-facing surface uses it — the chat surface (this file's
 * `resolvePublication` wiring), and the consumer credits surface
 * (apps/main/src/routes/consumer-metering.ts, issue #210) which resolves
 * publications by agent_id instead of slug but must apply the identical
 * state gate. Guardrails: private/draft → 404 (hide existence), paused →
 * 403. Returns a Response to short-circuit the caller, or null to allow the
 * request through.
 */
export function gatePublicationState(
  pub: Pick<PublicationRow, "visibility" | "status">,
): Response | null {
  if (pub.visibility === "private" || pub.status === "draft") {
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  if (pub.status === "paused") {
    return new Response(JSON.stringify({ error: "Publication paused" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }
  return null;
}

const DEFAULT_PUBLIC_SESSION_CAP_PER_SLUG = 50;
const DEFAULT_PUBLIC_SESSION_CAP_PER_IP = 20;

export function buildPublicPublicationRoutes(deps: PublicPublicationRoutesDeps) {
  const app = new Hono<{ Bindings: PublicEnv }>();

  // GET /p/:slug — hosted chat page (browser) or publication metadata (API).
  //
  // Content-negotiated (issue #178): a browser — including the embed widget's
  // iframe — sends `Accept: text/html` and gets the self-contained hosted chat
  // page; API clients (`application/json`, curl's default `*/*`) keep the
  // metadata JSON. The HTML surface fails closed exactly like the JSON one: a
  // hidden (404) or paused (403) publication renders a matching HTML error
  // page, never a working chat.
  app.get("/:slug", async (c) => {
    const wantsHtml = (c.req.header("accept") || "").includes("text/html");
    const resolved = await deps.resolvePublication(c.req.param("slug"), c.env);
    if (resolved instanceof Response) {
      return wantsHtml ? htmlGuardrailResponse(resolved.status) : resolved;
    }
    const pub = resolved;
    if (wantsHtml) return c.html(renderChatPage(pub));
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

  // GET /p/auth/verify?token=...&slug=... — clickable magic-link landing
  // page (issue #215). `slug` is a pure UX hint for where to return —
  // the magic-link token itself isn't scoped to any one publication, so an
  // unknown/mismatched slug just lands on that slug's own guardrail page
  // (hidden/paused), same as visiting it directly.
  //
  // Two-step consume (issue #254): corporate email scanners (Outlook Safe
  // Links etc.) pre-fetch every URL in an email, and the single-use token
  // used to be consumed right here on GET — a scanner could burn the link
  // before the human ever clicked it. GET is now a pure render (no token
  // exchange, safe to fetch any number of times); the actual verification
  // happens when the "Continue" button POSTs the token back to this same
  // path. Link-scanning bots issue GET/HEAD but don't submit forms.
  //
  // Registered here (2 path segments: "auth", "verify") rather than
  // colliding with the 1-segment `/:slug` route above — Hono only matches
  // a param route against paths with the same segment count, so this can't
  // be shadowed by (or shadow) a publication whose slug happens to be "auth".
  app.get("/auth/verify", async (c) => {
    const token = c.req.query("token");
    const slug = c.req.query("slug");
    if (!token || !slug) {
      return new Response(
        htmlErrorPage(
          "Invalid link",
          "This sign-in link is missing information and can't be used.",
        ),
        { status: 400, headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }
    return c.html(renderVerifyConfirmPage(new URL(c.req.url).pathname, slug, token));
  });

  // POST /p/auth/verify — consumes the single-use token (form-encoded
  // `token` + `slug` from the confirm page above). Exchanges it via the
  // SAME core logic as POST /v1/public/auth/verify (deps.verifyMagicLink —
  // consumer-auth.ts's verifyMagicLinkToken), stores the session token in
  // localStorage under the exact key the hosted chat page reads
  // (oma_pub_tok_<slug>), then bounces to /p/<slug>.
  app.post("/auth/verify", async (c) => {
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const token = typeof form.token === "string" ? form.token : undefined;
    const slug = typeof form.slug === "string" ? form.slug : undefined;
    if (!token || !slug) {
      return new Response(
        htmlErrorPage(
          "Invalid link",
          "This sign-in link is missing information and can't be used.",
        ),
        { status: 400, headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }

    if (!deps.verifyMagicLink) {
      return new Response(
        htmlErrorPage("Sign-in unavailable", "Please try again shortly."),
        { status: 500, headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }

    const result = await deps.verifyMagicLink(token, c.env);
    if (!result.ok) {
      return new Response(
        htmlErrorPage(
          "Link expired",
          `${result.error}. Sign-in links are valid for 15 minutes — request a new one and click it again.`,
          { href: `/p/${encodeURIComponent(slug)}`, label: "Back to chat" },
        ),
        { status: result.status, headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }

    return c.html(renderVerifyRedirectPage(slug, result.session_token));
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

    // Every session needs an environment_id at session-create now (see
    // packages/http-routes/src/sessions/index.ts) — detect the "will 400
    // downstream" case here so a visitor gets a clear, actionable message
    // instead of the raw session-create error (issue #225).
    if (!pub.environment_id) {
      return c.json(
        {
          error:
            "This bot isn't ready to chat yet — its publication has no environment configured. Ask the owner to set one.",
          code: "environment_required",
        },
        409,
      );
    }

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
        ...(pub.environment_id ? { environment_id: pub.environment_id } : {}),
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

/** Escape a string for safe interpolation into HTML text / double-quoted
 *  attributes. Publication title/greeting/avatar_url are creator-controlled,
 *  so every one goes through this before hitting the markup. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The self-contained hosted chat page for a live publication (issue #178).
 *
 * Fully dependency-free — inline CSS + a vanilla `<script>`, no framework, no
 * build step — so it ships straight from the worker (same spirit as
 * renderWidgetScript). It drives the public API that already exists:
 *
 *   1. POST /v1/public/auth/guest { publication_id }  → guest bearer token
 *      (stored in localStorage; survives reloads, upgradeable to email later)
 *   2. POST /p/:slug/sessions      (Bearer)           → conversation session id
 *   3. POST /p/:slug/sessions/:id/messages { content } (Bearer)
 *                                                      → SSE reply, streamed
 *      inline from the response body (agent.message_chunk deltas +
 *      agent.message final).
 *
 * A 402 (insufficient_credits) from step 3 surfaces a top-up prompt using the
 * server-supplied `top_up_url`; without one it shows a plain "needs credits"
 * message. Creator-controlled fields are HTML-escaped; the {id,slug} config is
 * injected as a `<`-neutralised JSON literal so it can't break out of the
 * script.
 */
export function renderChatPage(pub: PublicationRow): string {
  const title = escapeHtml(pub.title || "Chat");
  const desc = pub.description ? escapeHtml(pub.description) : "";
  const mono = escapeHtml((pub.title || "?").trim().charAt(0).toUpperCase() || "?");
  const avatar = pub.avatar_url
    ? `<img class="oma-avatar" src="${escapeHtml(pub.avatar_url)}" alt="" />`
    : `<div class="oma-avatar oma-avatar-mono">${mono}</div>`;
  const greetingRow = pub.greeting
    ? `<div class="oma-row oma-row-agent"><div class="oma-bubble oma-bubble-agent">${escapeHtml(
        pub.greeting,
      )}</div></div>`
    : "";
  const chips = (pub.suggested_prompts || [])
    .slice(0, 6)
    .map((p) => `<button type="button" class="oma-chip">${escapeHtml(p)}</button>`)
    .join("");
  // {id, slug} for the script — `<` neutralised so a slug/id can't inject
  // a closing </script>. Everything else the page needs is server-rendered.
  const cfg = JSON.stringify({ id: pub.id, slug: pub.slug }).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="robots" content="noindex" />
<title>${title}</title>
<style>
  :root {
    --bg: #ffffff; --surface: #f4f4f7; --fg: #1a1a1f; --muted: #6b6b76;
    --border: #e4e4ea; --brand: #5b5bd6; --brand-fg: #ffffff; --err: #b42318;
    --err-bg: #fef3f2; --err-border: #fecdca;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #16161a; --surface: #212127; --fg: #ececf1; --muted: #a0a0ad;
      --border: #2e2e37; --brand: #7d7dee; --brand-fg: #16161a; --err: #ff9c94;
      --err-bg: #2a1614; --err-border: #5a2a25;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    background: var(--bg); color: var(--fg);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    font-size: 15px; line-height: 1.5;
  }
  .oma-app { display: flex; flex-direction: column; height: 100dvh; max-width: 760px; margin: 0 auto; }
  .oma-header {
    display: flex; align-items: center; gap: 12px;
    padding: 12px 16px; border-bottom: 1px solid var(--border); flex: none;
  }
  .oma-avatar { width: 36px; height: 36px; border-radius: 50%; object-fit: cover; flex: none; }
  .oma-avatar-mono {
    display: flex; align-items: center; justify-content: center;
    background: var(--brand); color: var(--brand-fg); font-weight: 600;
  }
  .oma-head-text { min-width: 0; }
  .oma-title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .oma-desc { color: var(--muted); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .oma-messages { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
  .oma-row { display: flex; }
  .oma-row-user { justify-content: flex-end; }
  .oma-row-agent { justify-content: flex-start; }
  .oma-bubble { max-width: 80%; padding: 9px 13px; border-radius: 14px; white-space: pre-wrap; word-wrap: break-word; overflow-wrap: anywhere; }
  .oma-bubble-user { background: var(--brand); color: var(--brand-fg); border-bottom-right-radius: 4px; }
  .oma-bubble-agent { background: var(--surface); color: var(--fg); border: 1px solid var(--border); border-bottom-left-radius: 4px; }
  .oma-notice { align-self: center; text-align: center; font-size: 13px; color: var(--muted); max-width: 90%; }
  .oma-notice-error { color: var(--err); background: var(--err-bg); border: 1px solid var(--err-border); border-radius: 10px; padding: 8px 12px; }
  .oma-notice-paywall { display: flex; flex-direction: column; align-items: center; gap: 8px; color: var(--fg); background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px 16px; }
  .oma-topup { display: inline-block; background: var(--brand); color: var(--brand-fg); text-decoration: none; font-weight: 600; padding: 8px 16px; border-radius: 8px; }
  .oma-typing { display: inline-flex; gap: 4px; }
  .oma-typing span { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); animation: oma-blink 1.2s infinite both; }
  .oma-typing span:nth-child(2) { animation-delay: 0.2s; }
  .oma-typing span:nth-child(3) { animation-delay: 0.4s; }
  @keyframes oma-blink { 0%, 80%, 100% { opacity: 0.2; } 40% { opacity: 1; } }
  .oma-prompts { display: flex; flex-wrap: wrap; gap: 8px; padding: 0 16px 4px; }
  .oma-chip { background: var(--surface); color: var(--fg); border: 1px solid var(--border); border-radius: 999px; padding: 6px 12px; font-size: 13px; cursor: pointer; }
  .oma-chip:hover { border-color: var(--brand); }
  .oma-composer { display: flex; gap: 8px; padding: 12px 16px calc(12px + env(safe-area-inset-bottom)); border-top: 1px solid var(--border); flex: none; }
  .oma-input { flex: 1; resize: none; background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; font: inherit; outline: none; max-height: 140px; }
  .oma-input:focus { border-color: var(--brand); }
  .oma-send { flex: none; background: var(--brand); color: var(--brand-fg); border: 0; border-radius: 10px; padding: 0 18px; font: inherit; font-weight: 600; cursor: pointer; }
  .oma-send:disabled { opacity: 0.5; cursor: default; }
  .oma-footer { text-align: center; font-size: 11px; color: var(--muted); padding: 0 0 8px; }
</style>
</head>
<body>
<div class="oma-app">
  <header class="oma-header">
    ${avatar}
    <div class="oma-head-text">
      <div class="oma-title">${title}</div>
      ${desc ? `<div class="oma-desc">${desc}</div>` : ""}
    </div>
  </header>
  <div class="oma-messages" id="oma-messages">
    ${greetingRow}
  </div>
  <div class="oma-prompts" id="oma-prompts">${chips}</div>
  <form class="oma-composer" id="oma-form">
    <textarea class="oma-input" id="oma-input" rows="1" placeholder="Type a message…" autocomplete="off"></textarea>
    <button class="oma-send" id="oma-send" type="submit">Send</button>
  </form>
</div>
<script>
(function () {
  "use strict";
  var CFG = ${cfg};
  var slug = CFG.slug;
  var TOK_KEY = "oma_pub_tok_" + slug;
  var SESS_KEY = "oma_pub_sess_" + slug;
  var base = "/p/" + encodeURIComponent(slug);

  var messagesEl = document.getElementById("oma-messages");
  var formEl = document.getElementById("oma-form");
  var inputEl = document.getElementById("oma-input");
  var sendBtn = document.getElementById("oma-send");
  var promptsEl = document.getElementById("oma-prompts");
  var sending = false;

  function store(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function drop(k) { try { localStorage.removeItem(k); } catch (e) {} }
  function scrollBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }

  function addBubble(role, text) {
    var row = document.createElement("div");
    row.className = "oma-row oma-row-" + role;
    var b = document.createElement("div");
    b.className = "oma-bubble oma-bubble-" + role;
    b.textContent = text;
    row.appendChild(b);
    messagesEl.appendChild(row);
    scrollBottom();
    return b;
  }

  function addNotice(text, kind) {
    var n = document.createElement("div");
    n.className = "oma-notice" + (kind ? " oma-notice-" + kind : "");
    n.textContent = text;
    messagesEl.appendChild(n);
    scrollBottom();
    return n;
  }

  function addTyping() {
    var row = document.createElement("div");
    row.className = "oma-row oma-row-agent";
    var b = document.createElement("div");
    b.className = "oma-bubble oma-bubble-agent";
    b.innerHTML = '<span class="oma-typing"><span></span><span></span><span></span></span>';
    row.appendChild(b);
    messagesEl.appendChild(row);
    scrollBottom();
    return row;
  }

  function showPaywall(pay) {
    var n = document.createElement("div");
    n.className = "oma-notice oma-notice-paywall";
    var msg = document.createElement("div");
    msg.textContent = (pay && pay.top_up_url)
      ? "You're out of credits for this bot."
      : (readError(pay, 402) || "This bot requires credits to continue.");
    n.appendChild(msg);
    if (pay && pay.top_up_url) {
      var a = document.createElement("a");
      a.className = "oma-topup";
      a.href = pay.top_up_url;
      a.textContent = "Add credits";
      a.target = "_top";
      a.rel = "noopener";
      n.appendChild(a);
    }
    messagesEl.appendChild(n);
    scrollBottom();
  }

  function readError(body, status) {
    if (body && typeof body === "object") {
      if (typeof body.error === "string") return body.error;
      if (body.error && typeof body.error === "object" && body.error.message) return body.error.message;
      if (typeof body.message === "string") return body.message;
    }
    return "Request failed (" + status + ").";
  }

  function setBusy(b) {
    sending = b;
    inputEl.disabled = b;
    sendBtn.disabled = b;
    sendBtn.textContent = b ? "…" : "Send";
  }

  function hidePrompts() { if (promptsEl) promptsEl.style.display = "none"; }

  async function ensureToken() {
    var t = load(TOK_KEY);
    if (t) return t;
    var res = await fetch("/v1/public/auth/guest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publication_id: CFG.id }),
    });
    if (!res.ok) throw new Error("Could not start a session. Please try again.");
    var data = await res.json();
    store(TOK_KEY, data.session_token);
    return data.session_token;
  }

  async function ensureSession(token) {
    var s = load(SESS_KEY);
    if (s) return s;
    var res = await fetch(base + "/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      var err = await res.json().catch(function () { return {}; });
      throw new Error(readError(err, res.status));
    }
    var data = await res.json();
    store(SESS_KEY, data.id);
    return data.id;
  }

  async function send(text) {
    text = (text || "").trim();
    if (sending || !text) return;
    setBusy(true);
    hidePrompts();
    addBubble("user", text);

    var token, sessionId;
    try {
      token = await ensureToken();
      sessionId = await ensureSession(token);
    } catch (e) {
      addNotice(e && e.message ? e.message : "Something went wrong.", "error");
      setBusy(false);
      return;
    }

    var res;
    try {
      res = await fetch(base + "/sessions/" + sessionId + "/messages", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + token },
        body: JSON.stringify({ content: text }),
      });
    } catch (e) {
      addNotice("Network error — please try again.", "error");
      setBusy(false);
      return;
    }

    if (res.status === 402) {
      var pay = await res.json().catch(function () { return {}; });
      showPaywall(pay);
      setBusy(false);
      return;
    }
    if (!res.ok) {
      var eb = await res.json().catch(function () { return {}; });
      // A stale stored token/session self-heals: drop it so the next send
      // re-auths / re-creates instead of looping on the same bad id.
      if (res.status === 401) drop(TOK_KEY);
      if (res.status === 404) drop(SESS_KEY);
      addNotice(readError(eb, res.status), "error");
      setBusy(false);
      return;
    }

    var typing = addTyping();
    var bubble = null;
    var full = "";
    function ensureBubble() { if (!bubble) { if (typing) { typing.remove(); typing = null; } bubble = addBubble("agent", ""); } }

    try {
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = "";
      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        var lines = buffer.split("\\n");
        buffer = lines.pop() || "";
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          if (line.indexOf("data: ") !== 0) continue;
          var payload = line.slice(6).trim();
          if (!payload || payload === "[DONE]") continue;
          var ev;
          try { ev = JSON.parse(payload); } catch (e) { continue; }
          if (ev.type === "agent.message_chunk" && ev.delta) {
            ensureBubble();
            full += ev.delta;
            bubble.textContent = full;
            scrollBottom();
          } else if (ev.type === "agent.message" && ev.content) {
            ensureBubble();
            full = ev.content.map(function (c) { return c.text || ""; }).join("");
            bubble.textContent = full;
            scrollBottom();
          } else if (ev.type === "session.error") {
            addNotice(ev.message || ev.error || "The agent hit an error.", "error");
          }
        }
      }
    } catch (e) {
      addNotice("The connection dropped before the reply finished.", "error");
    }

    if (typing) { typing.remove(); typing = null; }
    if (!full && bubble) { bubble.parentNode.remove(); }
    setBusy(false);
    inputEl.focus();
  }

  formEl.addEventListener("submit", function (e) {
    e.preventDefault();
    var t = inputEl.value;
    inputEl.value = "";
    autoGrow();
    send(t);
  });

  inputEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      formEl.requestSubmit ? formEl.requestSubmit() : formEl.dispatchEvent(new Event("submit", { cancelable: true }));
    }
  });

  function autoGrow() {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + "px";
  }
  inputEl.addEventListener("input", autoGrow);

  if (promptsEl) {
    var chipEls = promptsEl.querySelectorAll(".oma-chip");
    for (var i = 0; i < chipEls.length; i++) {
      chipEls[i].addEventListener("click", function () { send(this.textContent); });
    }
  }

  inputEl.focus();
})();
</script>
</body>
</html>
`;
}

/** Fail-closed HTML for a hidden (404) / paused (403) publication — the
 *  human-readable mirror of the JSON guardrail the API surface returns, so a
 *  visitor never sees raw JSON (issue #178). */
function htmlGuardrailResponse(status: number): Response {
  const paused = status === 403;
  const heading = paused ? "This bot is paused" : "Bot not available";
  const body = paused
    ? "The owner has temporarily paused this bot. Please check back later."
    : "This link doesn't point to an available bot.";
  return new Response(htmlErrorPage(heading, body), {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/** Minimal, self-contained centered-card error page (theme-aware). */
/** Minimal, self-contained centered-card error page (theme-aware). Optional
 *  `cta` renders a link below the body text — used by the magic-link
 *  landing route (issue #215) for a "Back to chat" / request-a-new-link
 *  pointer on an expired/invalid token. */
function htmlErrorPage(heading: string, body: string, cta?: { href: string; label: string }): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(heading)}</title>
<style>
  :root { --bg:#ffffff; --fg:#1a1a1f; --muted:#6b6b76; --border:#e4e4ea; --brand:#5b5bd6; }
  @media (prefers-color-scheme: dark) { :root { --bg:#16161a; --fg:#ececf1; --muted:#a0a0ad; --border:#2e2e37; --brand:#7d7dee; } }
  html, body { margin: 0; height: 100%; }
  body { background: var(--bg); color: var(--fg); font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; }
  .card { max-width: 380px; text-align: center; padding: 32px; border: 1px solid var(--border); border-radius: 14px; margin: 16px; }
  h1 { font-size: 18px; margin: 0 0 8px; }
  p { color: var(--muted); font-size: 14px; margin: 0; }
  .cta { display: inline-block; margin-top: 16px; color: var(--brand); text-decoration: underline; font-size: 14px; }
</style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(heading)}</h1>
    <p>${escapeHtml(body)}</p>
    ${cta ? `<a class="cta" href="${escapeHtml(cta.href)}">${escapeHtml(cta.label)}</a>` : ""}
  </div>
</body>
</html>
`;
}

/** Pre-verify confirm page (issues #215, #254): the GET landing renders this
 *  form and nothing else — no token exchange — so an email scanner that
 *  pre-fetches the link can't burn the single-use token. Submitting POSTs
 *  `token` + `slug` back to the same path, which is what actually verifies. */
function renderVerifyConfirmPage(actionPath: string, slug: string, token: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<meta name="referrer" content="no-referrer" />
<title>Confirm sign-in</title>
<style>
  :root { --bg:#ffffff; --fg:#1a1a1f; --muted:#6b6b76; --border:#e4e4ea; --brand:#5b5bd6; --brand-fg:#ffffff; }
  @media (prefers-color-scheme: dark) { :root { --bg:#16161a; --fg:#ececf1; --muted:#a0a0ad; --border:#2e2e37; --brand:#7d7dee; --brand-fg:#16161a; } }
  html, body { margin: 0; height: 100%; }
  body { background: var(--bg); color: var(--fg); font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; }
  .card { max-width: 380px; text-align: center; padding: 32px; border: 1px solid var(--border); border-radius: 14px; margin: 16px; }
  h1 { font-size: 18px; margin: 0 0 8px; }
  p { color: var(--muted); font-size: 14px; margin: 0 0 20px; }
  button { background: var(--brand); color: var(--brand-fg); border: 0; border-radius: 10px; padding: 10px 24px; font-size: 15px; font-weight: 600; cursor: pointer; }
  button:hover { opacity: 0.9; }
</style>
</head>
<body>
  <div class="card">
    <h1>Confirm sign-in</h1>
    <p>Click continue to finish signing in and return to the chat.</p>
    <form method="post" action="${escapeHtml(actionPath)}">
      <input type="hidden" name="token" value="${escapeHtml(token)}" />
      <input type="hidden" name="slug" value="${escapeHtml(slug)}" />
      <button type="submit">Continue</button>
    </form>
  </div>
</body>
</html>
`;
}

/** Post-verify bounce page (issue #215): stores the freshly-minted consumer
 *  session token under the exact localStorage key the hosted chat page reads
 *  (`oma_pub_tok_<slug>`), then redirects to /p/<slug> already signed in. */
function renderVerifyRedirectPage(slug: string, sessionToken: string): string {
  const target = `/p/${encodeURIComponent(slug)}`;
  // `<` neutralised the same way renderChatPage's `cfg` literal is above, so
  // a pathological slug/token can't break out of the script tag.
  const tokKeyLiteral = JSON.stringify(`oma_pub_tok_${slug}`).replace(/</g, "\\u003c");
  const tokenLiteral = JSON.stringify(sessionToken).replace(/</g, "\\u003c");
  const targetLiteral = JSON.stringify(target).replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Signing you in…</title>
<style>
  :root { --bg:#ffffff; --fg:#1a1a1f; --muted:#6b6b76; }
  @media (prefers-color-scheme: dark) { :root { --bg:#16161a; --fg:#ececf1; --muted:#a0a0ad; } }
  html, body { margin: 0; height: 100%; }
  body { background: var(--bg); color: var(--fg); font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; }
  p { color: var(--muted); font-size: 14px; }
</style>
</head>
<body>
  <p>Signing you in…</p>
  <script>
    try { localStorage.setItem(${tokKeyLiteral}, ${tokenLiteral}); } catch (e) {}
    window.location.replace(${targetLiteral});
  </script>
</body>
</html>
`;
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
  env: PublicSessionCapsEnv,
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
