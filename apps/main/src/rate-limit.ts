import { createMiddleware } from "hono/factory";
import type { Env } from "@duyet/oma-shared";
import { logWarn } from "@duyet/oma-shared";
import { verifyTurnstile } from "./turnstile";

// Rate limiting via CF Workers Rate Limiting bindings (declared in
// wrangler.jsonc). Bindings give cross-isolate accuracy that the previous
// in-memory Map limiter lacked — a single isolate's counter underestimated
// real traffic by however many isolates the worker had spawned, which made
// the limit effectively N×limit/min in production.
//
// CF only supports period=10|60 (seconds), so all windows here are 60s.
// "X per hour" budgets get translated to a stricter "X' per minute" that
// covers the same threat model (e.g. 30/hour → 5/min).

/** Apply a rate-limiting binding. Soft-passes when binding is absent
 *  (dev/test harness). Returns true when the request should be rejected. */
async function exceeded(
  binding: RateLimit | undefined,
  key: string,
): Promise<boolean> {
  if (!binding) return false;
  try {
    const r = await binding.limit({ key });
    return !r.success;
  } catch (err) {
    // CF rate-limit binding very rarely errors; log and fail-open so
    // observability never breaks request handling.
    logWarn({ op: "rate_limit.binding", key, err }, "rate limit binding threw; failing open");
    return false;
  }
}

// ─── /v1/* limiter ───────────────────────────────────────────────────────
//
// Keyed by the authenticated principal so cookie-auth users each get their
// own bucket — the old "anonymous" fallback meant ALL cookie users shared
// one ceiling and a single user could DoS everyone else.
//
// Order: API key (CLI/SDK) > user_id (Console session) > IP (last-resort
// for unauthed bursts). Auth middleware runs before this and sets both
// tenant_id and user_id, so by the time we get here the right key is
// available unless the caller is genuinely anonymous.

function clientIp(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "anonymous"
  );
}

export const rateLimitMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: { tenant_id?: string; user_id?: string };
}>(async (c, next) => {
  const apiKey = c.req.header("x-api-key");
  const userId = c.get("user_id");
  const principal = apiKey
    ? `apikey:${apiKey.slice(0, 16)}` // prefix only — full key already auth'd
    : userId
      ? `user:${userId}`
      : `ip:${clientIp(c.req.raw)}`;
  const isWrite =
    c.req.method === "POST" || c.req.method === "PUT" || c.req.method === "DELETE";
  const binding = isWrite ? c.env.RL_API_USER_WRITE : c.env.RL_API_USER_READ;
  if (await exceeded(binding, principal)) {
    return c.json({ error: "Rate limit exceeded" }, 429);
  }
  await next();
});

// ─── /auth/* limiter ─────────────────────────────────────────────────────
//
// Three layers, all backed by separate CF bindings:
//
//   1. RL_AUTH_IP        — generic per-IP cap on the entire /auth/* surface
//      (catches credential stuffing on /auth/sign-in/email by sheer volume).
//   2. RL_AUTH_SEND_IP   — per-IP cap on email-triggering endpoints (limits
//      mail-budget burn from a single attacker).
//   3. RL_AUTH_SEND_EMAIL — per-email throttle (anti-spam-the-victim — even
//      if attacker rotates IPs, one email address can't be flooded).
//
// Body is read from a clone so better-auth still sees the original.

const EMAIL_SEND_PATHS = new Set([
  "/auth/sign-up/email",
  "/auth/sign-in/email",
  "/auth/forget-password",
  "/auth/email-otp/send-verification-otp",
  "/auth/email-otp/reset-password",
]);

async function peekEmail(req: Request): Promise<string> {
  try {
    const cloned = req.clone();
    const body = (await cloned.json()) as { email?: string };
    return (body?.email ?? "").toLowerCase().trim();
  } catch {
    return "";
  }
}

export const authRateLimitMiddleware = createMiddleware<{ Bindings: Env }>(
  async (c, next) => {
    const ip = clientIp(c.req.raw);
    const path = new URL(c.req.url).pathname;

    // Layer 1: generic per-IP throttle on the entire /auth/* surface.
    if (await exceeded(c.env.RL_AUTH_IP, ip)) {
      logWarn({ op: "auth.rate_limit.ip", ip, path }, "IP rate-limited on /auth/*");
      return c.json({ error: "Too many requests" }, 429);
    }

    if (!EMAIL_SEND_PATHS.has(path)) return next();

    // Bot-challenge gate: any email-triggering request must carry a valid
    // Turnstile token. This sits BEFORE the per-IP and per-email rate
    // limits so a flooding bot doesn't even get to consume the budget —
    // it gets a fast 401 and goes away. Verification soft-passes when
    // TURNSTILE_SECRET_KEY isn't configured (dev / pre-rollout).
    const turnstileToken = c.req.header("cf-turnstile-token");
    const ts = await verifyTurnstile(c.env.TURNSTILE_SECRET_KEY, turnstileToken, ip);
    if (!ts.ok) {
      logWarn(
        { op: "auth.turnstile.reject", ip, path, reason: ts.reason },
        "Turnstile verification rejected request",
      );
      return c.json(
        { error: "Bot challenge failed — refresh the page and try again" },
        401,
      );
    }

    // Layer 2: per-IP cap on email-triggering endpoints.
    if (await exceeded(c.env.RL_AUTH_SEND_IP, ip)) {
      logWarn({ op: "auth.rate_limit.send_ip", ip, path }, "IP exceeded email-send budget");
      return c.json({ error: "Too many email requests from this IP" }, 429);
    }

    // Layer 3: per-email throttle (anti-spam-the-victim).
    const email = await peekEmail(c.req.raw);
    if (email && (await exceeded(c.env.RL_AUTH_SEND_EMAIL, email))) {
      return c.json(
        { error: "Please wait a minute before requesting another email" },
        429,
      );
    }

    return next();
  },
);

// ─── Per-tenant cap on POST /v1/sessions ─────────────────────────────────
//
// Session creation spins up a sandbox container = real $$ per call. The
// generic /v1/* limiter (60 writes/min per user) would let one user burn
// 3600 sessions/hour. This stricter binding caps creation per-tenant so
// every member of the same workspace shares the budget — matches the
// billing model.
//
// Wired in routes/sessions.ts on the POST handler.

export async function rateLimitSessionCreate(
  env: Env,
  tenantId: string,
): Promise<Response | null> {
  if (await exceeded(env.RL_SESSIONS_TENANT, `tenant:${tenantId}`)) {
    return Response.json(
      { error: "Too many session creations — wait a minute" },
      { status: 429 },
    );
  }
  return null;
}

// ─── Per-email cap on consumer magic-link requests (issue #162) ─────────
//
// Same anti-spam-the-victim threat model as RL_AUTH_SEND_EMAIL (layer 3
// above), scoped to the separate /v1/public/auth/* consumer realm — an
// attacker who doesn't own an email can otherwise flood it with magic-link
// requests. Wired in routes/consumer-auth.ts.

export async function rateLimitMagicLinkEmail(
  binding: RateLimit | undefined,
  email: string,
): Promise<boolean> {
  return exceeded(binding, `magiclink:${email}`);
}

// ─── Per-deployment cap on the unauthenticated webhook run endpoint ──────────
//
// POST /v1/deployment_hooks/:hook_token is unauthenticated (token-secured) and
// spins up a full sandbox session per call. Without a cap, a leaked hook token
// could fan out unbounded expensive runs. Keyed per deployment so one hot
// deployment can't exhaust others. Reuses the session-creation binding (same
// "session spin-up is $$" threat model) under a `dephook:` key namespace so it
// never collides with the `tenant:` keys rateLimitSessionCreate uses.

export async function rateLimitDeploymentHook(
  env: Env,
  deploymentId: string,
): Promise<Response | null> {
  if (await exceeded(env.RL_SESSIONS_TENANT, `dephook:${deploymentId}`)) {
    return Response.json(
      { error: "Too many webhook runs for this deployment — wait a minute" },
      { status: 429 },
    );
  }
  return null;
}

// ─── Per-tenant cap on the MCP proxy forward path (issue #200) ──────────
//
// apps/main/src/routes/mcp-proxy.ts is the only layer that ever holds a
// plaintext upstream MCP bearer token, which also makes it the natural
// place to bound abuse — one session (or several sessions sharing a
// tenant's vault credential) could otherwise hammer an upstream MCP server
// unbounded. Keyed by tenant (not session) because the vault credential —
// the resource actually being protected — is shared tenant-wide. MCP tool
// calls happen many times per turn at model-decided cadence, so this
// budget is deliberately more generous than RL_SESSIONS_TENANT /
// RL_UPLOAD_TENANT: the goal is to stop a runaway/looping session, not
// throttle ordinary multi-tool-call usage.
//
// Called directly from forwardWithRefresh (not mounted as Hono middleware)
// so it covers all three callers uniformly — the HTTP
// /v1/mcp-proxy/:sid/:server endpoint and both McpProxyRpc RPC paths
// (mcpForward/fetch, outboundForward) — from one chokepoint. Also reused
// by the _health route's optional ?probe=1 real-connectivity check
// (issue #201) so a health-page poller can't bypass the same budget by
// hammering probes instead of the forward path.

export async function rateLimitMcpProxy(
  binding: RateLimit | undefined,
  tenantId: string,
): Promise<boolean> {
  return exceeded(binding, `mcp:${tenantId}`);
}

export const windows = new Map<string, number[]>();

export function isRateLimited(
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): boolean {
  const cutoff = now - windowMs;
  const hits = (windows.get(key) ?? []).filter((ts) => ts > cutoff);
  if (hits.length >= limit) {
    windows.set(key, hits);
    return true;
  }
  hits.push(now);
  windows.set(key, hits);
  return false;
}
