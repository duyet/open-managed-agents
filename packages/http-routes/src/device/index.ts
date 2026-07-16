// Device Authorization Grant (RFC 8628) — headless CLI login.
//
// Two public endpoints drive the CLI's `oma auth login --device` flow:
//   POST /code    → issue a device_code + user_code (no auth)
//   POST /token   → poll: exchange device_code for tokens once approved (no auth)
// and one cookie-gated endpoint completes it:
//   POST /approve → called by the console page after the user logs in + picks
//                   workspaces; mints real API keys per selected tenant.
//
// Pending codes are stored in the runtime-agnostic KvStore (services.kv) with
// a TTL, mirroring the existing cap-cli-oauth device flow. The final tokens
// come from the SAME mintApiKey dependency the browser-handoff /me/cli-tokens
// route uses, so device-minted keys are indistinguishable from logged-in ones.

import { Hono } from "hono";
import { randomBytes, randomInt } from "node:crypto";
import type { RouteServicesArg } from "../types";
import { resolveServices } from "../types";

interface Vars {
  Variables: { tenant_id: string; user_id?: string };
}

const CODE_TTL_SEC = 15 * 60;
// How long an approved-but-uncollected code stays readable by the poller
// after the user clicks Approve. Short — the CLI collects within seconds.
const APPROVED_GRACE_SEC = 120;
const POLL_INTERVAL_SEC = 5;

// Avoid ambiguous characters (0/O, 1/I/l) for the human-entered user_code.
const USER_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

interface DeviceRecord {
  device_code: string;
  user_code: string;
  status: "pending" | "approved";
  created_at: string;
  expires_at: string;
  tokens: DeviceToken[] | null;
  approved_user_id: string | null;
  last_poll_at: number;
}

export interface DeviceToken {
  tenant_id: string;
  tenant_name: string;
  role: string;
  token: string;
  key_id: string;
}

export interface DeviceRoutesDeps {
  services: RouteServicesArg;
  /** Mint a long-lived API key. Shares the implementation with
   *  POST /v1/me/cli-tokens (cfApiKeyStorage on CF, sql api_keys on Node). */
  mintApiKey: (input: {
    tenantId: string;
    userId: string;
    name: string;
    source?: string;
  }) => Promise<{ id: string; key: string; prefix: string; createdAt: string }>;
  /** Enforce the approver is a member of each tenant they authorize. */
  hasMembership: (userId: string, tenantId: string) => Promise<boolean>;
  /** Resolve a tenant's display name for the token payload. */
  loadTenant?: (tenantId: string) => Promise<{ id: string; name: string } | null>;
}

function kvKey(deviceCode: string): string {
  return `device:${deviceCode}`;
}

function genUserCode(): string {
  let s = "";
  for (let i = 0; i < 8; i++) {
    s += USER_CODE_ALPHABET[randomInt(0, USER_CODE_ALPHABET.length)];
    if (i === 3) s += "-";
  }
  return s;
}

export function buildDeviceRoutes(deps: DeviceRoutesDeps) {
  const app = new Hono<Vars>();

  // ── POST /code ── issue a device_code + user_code. Public.
  app.post("/code", async (c) => {
    const services = resolveServices(deps.services, c);
    const device_code = randomBytes(32).toString("hex");
    const user_code = genUserCode();
    const now = Date.now();
    const record: DeviceRecord = {
      device_code,
      user_code,
      status: "pending",
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + CODE_TTL_SEC * 1000).toISOString(),
      tokens: null,
      approved_user_id: null,
      last_poll_at: 0,
    };
    await services.kv.put(kvKey(device_code), JSON.stringify(record), {
      expirationTtl: CODE_TTL_SEC,
    });
    return c.json({
      device_code,
      user_code,
      verification_uri: "/cli/device",
      interval: POLL_INTERVAL_SEC,
      expires_in: CODE_TTL_SEC,
    });
  });

  // ── POST /token ── polled by the CLI. Public (no key yet).
  app.post("/token", async (c) => {
    const services = resolveServices(deps.services, c);
    const body = await c.req
      .json<{ device_code?: string }>()
      .catch(() => ({}) as { device_code?: string });
    const deviceCode = body.device_code;
    if (!deviceCode) {
      return c.json({ error: "invalid_request", error_description: "device_code required" }, 400);
    }
    const raw = await services.kv.get(kvKey(deviceCode));
    if (!raw) {
      // Missing/deleted key ⇒ expired or already collected.
      return c.json(
        { error: "expired_token", error_description: "The code has expired or was already used." },
        400,
      );
    }
    const record = JSON.parse(raw) as DeviceRecord;

    if (record.status === "approved" && record.tokens) {
      // Hand off the tokens, then delete so they can't be replayed.
      await services.kv.delete(kvKey(deviceCode));
      return c.json({ tokens: record.tokens });
    }

    // Pending. Enforce a minimum poll interval to throttle the CLI.
    const now = Date.now();
    const sinceLast = now - record.last_poll_at;
    const tooSoon = record.last_poll_at !== 0 && sinceLast < POLL_INTERVAL_SEC * 1000;
    record.last_poll_at = now;
    await services.kv.put(kvKey(deviceCode), JSON.stringify(record), {
      expirationTtl: CODE_TTL_SEC,
    });
    if (tooSoon) {
      return c.json(
        { error: "slow_down", interval: POLL_INTERVAL_SEC, error_description: "Poll too fast." },
        400,
      );
    }
    return c.json(
      {
        error: "authorization_pending",
        interval: POLL_INTERVAL_SEC,
        error_description: "Awaiting approval in your browser.",
      },
      400,
    );
  });

  // ── POST /approve ── console page, cookie session required.
  app.post("/approve", async (c) => {
    const services = resolveServices(deps.services, c);
    const userId = c.var.user_id;
    if (!userId) {
      return c.json({ error: "Cookie session required to approve device login" }, 403);
    }
    const body = await c.req
      .json<{ device_code?: string; tenant_ids?: string[] }>()
      .catch(() => ({}) as { device_code?: string; tenant_ids?: string[] });
    const deviceCode = body.device_code;
    const tenantIds = body.tenant_ids ?? [];
    if (!deviceCode) {
      return c.json({ error: "device_code required" }, 400);
    }
    if (tenantIds.length === 0) {
      return c.json({ error: "select at least one workspace" }, 400);
    }

    const raw = await services.kv.get(kvKey(deviceCode));
    if (!raw) {
      return c.json({ error: "The login code has expired. Run `oma auth login --device` again." }, 404);
    }
    const record = JSON.parse(raw) as DeviceRecord;
    if (record.status === "approved") {
      return c.json({ status: "approved" });
    }

    // Authorize only tenants the approver actually belongs to.
    const tokens: DeviceToken[] = [];
    for (const tenantId of tenantIds) {
      const ok = deps.hasMembership ? await deps.hasMembership(userId, tenantId) : true;
      if (!ok) {
        return c.json(
          { type: "error", error: { type: "not_a_member", message: `Not a member of ${tenantId}` } },
          403,
        );
      }
      const minted = await deps.mintApiKey({
        tenantId,
        userId,
        name: "CLI device",
        source: "cli",
      });
      const t = deps.loadTenant ? await deps.loadTenant(tenantId) : null;
      tokens.push({
        tenant_id: tenantId,
        tenant_name: t?.name ?? "",
        role: "owner",
        token: minted.key,
        key_id: minted.id,
      });
    }

    record.status = "approved";
    record.tokens = tokens;
    record.approved_user_id = userId;
    await services.kv.put(kvKey(deviceCode), JSON.stringify(record), {
      expirationTtl: APPROVED_GRACE_SEC,
    });
    return c.json({ status: "approved" });
  });

  return app;
}
