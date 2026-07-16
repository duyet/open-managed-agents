// Boot-time secret gate for the Cloudflare deployment (oma#220).
//
// apps/main-node fails fast at process boot — it calls
// findLeakedPlaceholderSecrets() before anything else and exits(1) if a
// secret matches a value that used to ship prefilled in .env.example (see
// oma#170 / oma#219). A Cloudflare Worker has no equivalent boot phase: the
// module top-level runs once per isolate, but bindings/secrets aren't
// guaranteed populated until the first request's `env` is handed in. The
// honest seam on Workers is "first request", so `index.ts` wires this as a
// memoized middleware instead of a boot-time check.
//
// Two failure modes with different consequences:
//   - missing: BETTER_AUTH_SECRET / PLATFORM_ROOT_SECRET unset entirely →
//     refuse to serve (503). Nothing upstream checked this before now —
//     auth-config.ts handed `undefined` straight to better-auth, and
//     packages/services only throws once a route happens to construct the
//     Services container.
//   - leaked: set, but to one of the historically-public .env.example
//     values (packages/shared/src/known-insecure-secrets.ts) → serve, but
//     log an operator-facing error once per isolate. Blocking here is not
//     actionable for a running deployment: GITHUB_CLIENT_SECRET can only be
//     rotated in the GitHub OAuth app UI, and rotating PLATFORM_ROOT_SECRET
//     makes every stored encrypted credential unreadable — both need a
//     planned operator migration (oma#242), not a hard outage.
import type { MiddlewareHandler } from "hono";
import { findLeakedPlaceholderSecrets, formatLeakedSecretError } from "@duyet/oma-shared";

/** Secrets this Cloudflare Worker cannot safely serve traffic without. */
export const REQUIRED_BOOT_SECRETS = ["BETTER_AUTH_SECRET", "PLATFORM_ROOT_SECRET"] as const;

/**
 * Returns a clear operator-facing message when a required boot secret is
 * missing or leaked, or `null` when both are clean. Pure function of an
 * env-like bag (not the typed `Env`, since the whole point is that the
 * type's `BETTER_AUTH_SECRET: string` promise doesn't hold at runtime) so
 * it's unit-testable without a real Cloudflare binding.
 *
 * `findLeaked` is injectable (defaults to the real denylist check) purely
 * so tests can exercise the leaked-secret branch with a fake result —
 * known-insecure-secrets.ts deliberately stores only SHA-256 digests so
 * the actual leaked plaintext never re-appears in a fresh commit, and a
 * test fixture is exactly the kind of fresh commit that rule guards
 * against.
 */
export interface BootSecretVerdict {
  /** Refuse-to-serve message (required secret entirely unset), or null. */
  block: string | null;
  /** Serve-but-nag message (secret set to a historically-leaked value), or null. */
  warn: string | null;
}

export async function checkBootSecrets(
  env: Record<string, string | undefined>,
  findLeaked: (
    env: Record<string, string | undefined>,
  ) => Promise<string[]> = findLeakedPlaceholderSecrets,
): Promise<BootSecretVerdict> {
  const missing = REQUIRED_BOOT_SECRETS.filter((key) => !env[key]);
  if (missing.length > 0) {
    return {
      block:
        `Refusing to serve requests: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set. ` +
        `Configure ${missing.length === 1 ? "it" : "them"} via \`wrangler secret put\` before this deployment ` +
        `can serve traffic (see AGENTS.md → "Required secrets").`,
      warn: null,
    };
  }

  const leaked = await findLeaked(env);
  if (leaked.length > 0) {
    return { block: null, warn: formatLeakedSecretError(leaked) };
  }

  return { block: null, warn: null };
}

/**
 * Hono middleware factory wrapping {@link checkBootSecrets}: computes the
 * verdict once (memoized in this instance's closure) and returns 503 for
 * every request until the underlying secrets are fixed and the isolate
 * restarts. A factory (rather than a bare middleware + module-level `let`)
 * so tests can create an isolated instance instead of touching the real
 * app's shared memoized state.
 */
export function createBootSecretGate(
  findLeaked?: (env: Record<string, string | undefined>) => Promise<string[]>,
): MiddlewareHandler {
  let cached: BootSecretVerdict | undefined;
  let warned = false;
  return async (c, next) => {
    if (cached === undefined) {
      cached = await checkBootSecrets(
        c.env as unknown as Record<string, string | undefined>,
        findLeaked,
      );
    }
    if (cached.block) {
      return c.json({ error: cached.block }, 503);
    }
    if (cached.warn && !warned) {
      warned = true;
      console.error(`[boot-secrets] ${cached.warn}`);
    }
    await next();
  };
}
