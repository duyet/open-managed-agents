// Healthchecks.io ping integration for OMA cron jobs and lifecycle events.
//
// Healthchecks.io (https://healthchecks.io) is a cron job monitoring service.
// It expects periodic HTTP pings from your services. If a ping is missed,
// it alerts you.
//
// Usage:
//   import { pingHealthchecks } from "@duyet/oma-shared";
//
//   // Ping success (job completed)
//   await pingHealthchecks(env, "success", "memory-retention tick done");
//
//   // Ping start (job started)
//   await pingHealthchecks(env, "start", "memory-retention tick");
//
//   // Ping failure (job failed)
//   await pingHealthchecks(env, "fail", "memory-retention tick crashed");
//
// Configuration:
//   HEALTHCHECKS_IO_URL — base ping URL (UUID or slug format).
//     UUID format: https://hc-ping.com/<uuid>
//     Slug format: https://hc-ping.com/<ping-key>/<slug>
//     The utility appends /start, /fail, /log automatically.

import { logError } from "./log";

export type HealthcheckStatus = "start" | "success" | "fail" | "log";

export interface HealthchecksEnv {
  /** Base Healthchecks.io ping URL (UUID or slug format).
   *  UUID: https://hc-ping.com/<uuid>
   *  Slug: https://hc-ping.com/<ping-key>/<slug>
   *  When set, OMA sends start/success/failure pings for cron jobs. */
  HEALTHCHECKS_IO_URL?: string;
}

/** Ping Healthchecks.io with the given status.
 *
 *  Returns true if the ping was sent successfully, false if
 *  HEALTHCHECKS_IO_URL is not configured or the request failed.
 *
 *  The function is intentionally fire-and-forget-friendly — it logs
 *  failures but never throws, so it's safe to use in cron job handlers
 *  without disrupting the main flow.
 */
export async function pingHealthchecks(
  env: HealthchecksEnv,
  status: HealthcheckStatus,
  body?: string,
): Promise<boolean> {
  const baseUrl = env.HEALTHCHECKS_IO_URL;
  if (!baseUrl || !baseUrl.trim()) return false;

  // Build the ping URL by appending the status suffix.
  // UUID format: https://hc-ping.com/<uuid>[/start|/fail|/log]
  // Slug format: https://hc-ping.com/<ping-key>/<slug>[/start|/fail|/log]
  const url = status === "success"
    ? baseUrl.replace(/\/+$/, "")
    : `${baseUrl.replace(/\/+$/, "")}/${status}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: body ? { "content-type": "text/plain" } : undefined,
      body: body || undefined,
    });

    if (!response.ok) {
      logError(
        {
          op: "healthchecks.ping",
          status,
          httpStatus: response.status,
          url: sanitizeUrl(url),
        },
        `healthchecks.io ping failed with status ${response.status}`,
      );
      return false;
    }

    return true;
  } catch (err) {
    logError(
      { op: "healthchecks.ping", status, err, url: sanitizeUrl(url) },
      "healthchecks.io ping error",
    );
    return false;
  }
}

/** Wrap a cron job handler with healthchecks.io start/success/failure pings.
 *
 *  Example:
 *    scheduler.register({
 *      name: "memory-retention",
 *      cron: "* * * * *",
 *      handler: withHealthchecks(env, "memory-retention", memoryRetentionHandler),
 *    });
 *
 *  On each tick:
 *    1. Sends a "start" ping to healthchecks.io
 *    2. Runs the handler
 *    3. Sends a "success" ping on completion, or "fail" if the handler throws
 */
export function withHealthchecks<T extends Array<unknown>, R>(
  env: HealthchecksEnv,
  jobName: string,
  handler: (...args: T) => Promise<R>,
): (...args: T) => Promise<R> {
  return async (...args: T): Promise<R> => {
    // Send start ping (fire-and-forget)
    pingHealthchecks(env, "start", `Job "${jobName}" started`).catch(() => {});

    try {
      const result = await handler(...args);

      // Send success ping (fire-and-forget)
      pingHealthchecks(env, "success", `Job "${jobName}" completed successfully`).catch(() => {});

      return result;
    } catch (err) {
      // Send failure ping with error details (fire-and-forget)
      const errorMessage = err instanceof Error ? err.message : String(err);
      pingHealthchecks(
        env,
        "fail",
        `Job "${jobName}" failed: ${errorMessage}`,
      ).catch(() => {});

      // Re-throw so the caller still sees the failure
      throw err;
    }
  };
}

/** Sanitize a Healthchecks.io URL for logging — mask the UUID or ping-key
 *  portion so secrets don't leak into logs. */
function sanitizeUrl(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);

    // UUID format: /<uuid> — mask the UUID
    // Slug format: /<ping-key>/<slug> — mask the ping-key, keep slug
    if (parts.length === 1) {
      // UUID — show first 6 chars
      return `${u.protocol}//${u.host}/${parts[0]!.slice(0, 6)}****`;
    }
    if (parts.length >= 2) {
      // Slug — mask the ping-key, keep slug
      return `${u.protocol}//${u.host}/****/${parts.slice(1).join("/")}`;
    }
    return `${u.protocol}//${u.host}/****`;
  } catch {
    return "<invalid-url>";
  }
}
