// Consumer (end-user) auth realm — issue #73.
//
// The handler logic + storage port moved to the shared, runtime-neutral factory
// (@duyet/oma-http-routes → packages/http-routes/src/public/consumer-auth.ts)
// so the Cloudflare worker (this file) and the self-host Node server
// (apps/main-node) mount the identical /v1/public/auth/* routes (issue #226).
// This file only wires the CF-specific ports: the store over env.MAIN_DB (D1),
// the SEND_EMAIL binding, and the RL_MAGICLINK_EMAIL rate-limiter.

import type { Env } from "@duyet/oma-shared";
import {
  buildConsumerAuthRoutes,
  createSqlConsumerAuthStore,
  verifyMagicLinkToken as verifyMagicLinkTokenWithStore,
  type ConsumerSessionRow,
  type VerifyMagicLinkResult,
} from "@duyet/oma-http-routes";
import { sqlClientFromD1 } from "@duyet/oma-sql-client/adapters/cf-d1";
import { sendEmail } from "../auth-config";
import { rateLimitMagicLinkEmail } from "../rate-limit";

/** The request-scoped bindings the CF consumer-auth ports read. */
interface CfConsumerAuthEnv {
  MAIN_DB: D1Database;
  SEND_EMAIL?: Env["SEND_EMAIL"];
  RL_MAGICLINK_EMAIL?: RateLimit;
  /** Dev/test escape hatch (issue #162) — ONLY when exactly "1" or "true" does
   *  /auth/magic-link echo the raw token back in the response body. Default
   *  (unset/anything else): token is never returned, only delivered via email.
   *  Never enable in production. */
  CONSUMER_AUTH_DEV_ECHO_TOKEN?: string;
}

/**
 * Resolve a consumer bearer token to its (unexpired) session row. Kept as a
 * D1-signatured helper for callers that already hold a D1Database
 * (apps/main/src/index.ts resolveEndUserId + routes/consumer-metering's
 * requireConsumer guard) so the expiry check lives in exactly one place.
 * Returns null for a missing/expired token (the caller decides the status).
 */
export async function resolveConsumerSession(
  db: D1Database,
  token: string,
): Promise<ConsumerSessionRow | null> {
  return createSqlConsumerAuthStore(sqlClientFromD1(db)).resolveConsumerSession(token);
}

/**
 * Verify a magic-link token. Kept as a D1-signatured helper for the same
 * reason as resolveConsumerSession above: apps/main/src/index.ts's clickable
 * /p/auth/verify landing page (issue #215) already holds a D1Database, so the
 * store adapter is wired here rather than at that call site.
 */
export async function verifyMagicLinkToken(
  db: D1Database,
  token: string,
): Promise<VerifyMagicLinkResult> {
  return verifyMagicLinkTokenWithStore(createSqlConsumerAuthStore(sqlClientFromD1(db)), token);
}

const wrapper = buildConsumerAuthRoutes({
  store: (c) => createSqlConsumerAuthStore(sqlClientFromD1((c.env as CfConsumerAuthEnv).MAIN_DB)),
  sendEmail: async (c, msg) => {
    await sendEmail(c.env as CfConsumerAuthEnv, msg.to, msg.subject, msg.html, msg.text);
  },
  rateLimitMagicLinkEmail: (c, email) =>
    rateLimitMagicLinkEmail((c.env as CfConsumerAuthEnv).RL_MAGICLINK_EMAIL, email),
  devEchoToken: (c) => {
    const v = (c.env as CfConsumerAuthEnv).CONSUMER_AUTH_DEV_ECHO_TOKEN;
    return v === "1" || v === "true";
  },
});

export default wrapper;
