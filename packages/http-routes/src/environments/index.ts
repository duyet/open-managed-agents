// Environments — full CRUD, ported from apps/main/src/routes/environments.ts
// into the shared bundle both apps/main (CF) and apps/main-node consume.
//
// The CF app still mounts its own local route file (apps/main/src/routes/
// environments.ts) — this bundle exists so apps/main-node stops 404ing on
// POST /v1/environments (the route was never mounted there before). Same
// behavior, same status codes, same JSON shapes.
//
// Differences vs the CF-local file:
//   - Uses RouteServicesArg / resolveServices (services.environments) rather
//     than the CF-only `c.var.services` context var — same convention as the
//     agents / vaults bundles.
//   - The field-size caps helper (validateEnvironmentLimits) is CF-app-local
//     (apps/main/src/lib/limits.ts); it doesn't exist on the Node side, so a
//     small self-contained equivalent lives here.
//   - List pagination mirrors the vaults bundle's `{ data, next_cursor?,
//     has_more }` shape (the CF-local file used jsonPage → `next_page`; the
//     Console reads `next_cursor`, which both emit, so it works against
//     either host).

import { Hono } from "hono";
import type { EnvironmentConfig } from "@duyet/oma-shared";
import {
  toEnvironmentConfig,
  EnvironmentNotFoundError,
} from "@duyet/oma-environments-store";
import type { RouteServicesArg } from "../types";
import { resolveServices } from "../types";

interface Vars {
  Variables: { tenant_id: string };
}

// ── Field-size caps ──────────────────────────────────────────────────────
// Self-contained equivalent of apps/main/src/lib/limits.ts (environment
// slice only). Mirrors the Anthropic Managed Agents caps for shared fields
// plus the OMA-specific dockerfile / packages caps. Enforced on POST/PUT
// only — existing rows that predate the caps stay readable.

type ValidationResult = { ok: true } | { ok: false; error: string };

const NAME_MAX = 256;
const DESCRIPTION_MAX = 2048;
const METADATA_KEYS_MAX = 16;
const METADATA_KEY_CHARS_MAX = 64;
const METADATA_VALUE_CHARS_MAX = 512;
const DOCKERFILE_MAX = 100_000;
const PACKAGES_PER_ECO_MAX = 100;

interface EnvironmentLimitsInput {
  name?: string;
  description?: string | null;
  config?: {
    type?: string;
    dockerfile?: string;
    packages?: Record<string, unknown>;
    [k: string]: unknown;
  } | null;
  metadata?: Record<string, unknown> | null;
}

function validateMetadata(field: string, metadata: unknown): ValidationResult {
  if (metadata === undefined || metadata === null) return { ok: true };
  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    return { ok: false, error: `${field} must be an object` };
  }
  const entries = Object.entries(metadata as Record<string, unknown>);
  if (entries.length > METADATA_KEYS_MAX) {
    return { ok: false, error: `${field} has ${entries.length} keys; max ${METADATA_KEYS_MAX}` };
  }
  for (const [k, v] of entries) {
    if (k.length > METADATA_KEY_CHARS_MAX) {
      return {
        ok: false,
        error: `${field}.${k} key length ${k.length} exceeds ${METADATA_KEY_CHARS_MAX}`,
      };
    }
    const serialized = typeof v === "string" ? v : JSON.stringify(v);
    if (serialized.length > METADATA_VALUE_CHARS_MAX) {
      return {
        ok: false,
        error: `${field}.${k} value length ${serialized.length} exceeds ${METADATA_VALUE_CHARS_MAX}`,
      };
    }
  }
  return { ok: true };
}

function validateEnvironmentLimits(input: EnvironmentLimitsInput): ValidationResult {
  if (input.name !== undefined && input.name.length > NAME_MAX) {
    return { ok: false, error: `name length ${input.name.length} exceeds ${NAME_MAX}` };
  }
  if (
    input.description !== undefined &&
    input.description !== null &&
    input.description.length > DESCRIPTION_MAX
  ) {
    return {
      ok: false,
      error: `description length ${input.description.length} exceeds ${DESCRIPTION_MAX}`,
    };
  }
  if (input.config) {
    const dockerfile = input.config.dockerfile;
    if (typeof dockerfile === "string" && dockerfile.length > DOCKERFILE_MAX) {
      return {
        ok: false,
        error: `config.dockerfile length ${dockerfile.length} exceeds ${DOCKERFILE_MAX}`,
      };
    }
    const packages = input.config.packages;
    if (packages && typeof packages === "object") {
      for (const [eco, list] of Object.entries(packages)) {
        if (Array.isArray(list) && list.length > PACKAGES_PER_ECO_MAX) {
          return {
            ok: false,
            error: `config.packages.${eco} length ${list.length} exceeds ${PACKAGES_PER_ECO_MAX}`,
          };
        }
      }
    }
  }
  return validateMetadata("metadata", input.metadata);
}

export interface EnvironmentRoutesDeps {
  services: RouteServicesArg;
}

export function buildEnvironmentRoutes(deps: EnvironmentRoutesDeps) {
  const app = new Hono<Vars>();

  // POST /v1/environments — create environment
  app.post("/", async (c) => {
    const services = resolveServices(deps.services, c);
    if (!services.environments) {
      return c.json({ error: "environments service not configured" }, 500);
    }
    const t = c.var.tenant_id;
    const body = (await c.req.json()) as {
      name: string;
      description?: string;
      config?: EnvironmentConfig["config"];
    };

    if (!body.name) {
      return c.json({ error: "name is required" }, 400);
    }

    const limitCheck = validateEnvironmentLimits(body);
    if (!limitCheck.ok) {
      return c.json({ error: limitCheck.error }, 400);
    }

    const row = await services.environments.create({
      tenantId: t,
      name: body.name,
      description: body.description,
      config: body.config || { type: "cloud" },
      // Setup-on-warmup means env is immediately usable — no async build.
      status: "ready",
      sandboxWorkerName: "sandbox-default",
      imageStrategy: null,
    });

    return c.json(toEnvironmentConfig(row), 201);
  });

  // GET /v1/environments — list environments (cursor-paginated)
  app.get("/", async (c) => {
    const services = resolveServices(deps.services, c);
    if (!services.environments) {
      return c.json({ error: "environments service not configured" }, 500);
    }
    const t = c.var.tenant_id;
    const limitStr = c.req.query("limit");
    const limit = limitStr ? Math.min(Math.max(1, Number(limitStr)), 100) : 50;
    const cursor = c.req.query("cursor") || c.req.query("page") || undefined;
    const qRaw = c.req.query("q");
    const q = qRaw && qRaw.trim() ? qRaw.trim() : undefined;

    // status: enum filter on archive state. Whitelist strictly — any
    // unknown value is a 400, NOT a silent fallback to "any". Allowing
    // arbitrary strings here would mask client bugs (typo'd "active "
    // returning every row looks like a feature).
    const statusRaw = c.req.query("status");
    let status: "active" | "archived" | "any" | undefined;
    if (statusRaw !== undefined) {
      if (statusRaw === "active" || statusRaw === "archived" || statusRaw === "any") {
        status = statusRaw;
      } else {
        return c.json(
          {
            error: {
              type: "invalid_request_error",
              code: "invalid_status",
              message: `Invalid status '${statusRaw}'; expected one of active|archived|any.`,
            },
          },
          400,
        );
      }
    }

    // created_after / created_before: ISO timestamps → epoch ms. Reject
    // unparseable values explicitly so the client knows it's a malformed
    // request, not just "no results".
    const parseMs = (
      raw: string | undefined,
      field: string,
    ): { value: number | undefined; err?: Response } => {
      if (raw === undefined) return { value: undefined };
      const ms = Date.parse(raw);
      if (Number.isNaN(ms)) {
        return {
          value: undefined,
          err: c.json(
            {
              error: {
                type: "invalid_request_error",
                code: "invalid_timestamp",
                message: `Invalid ${field} '${raw}'; expected ISO-8601 timestamp.`,
              },
            },
            400,
          ),
        };
      }
      return { value: ms };
    };
    const createdAfterRes = parseMs(c.req.query("created_after"), "created_after");
    if (createdAfterRes.err) return createdAfterRes.err;
    const createdBeforeRes = parseMs(c.req.query("created_before"), "created_before");
    if (createdBeforeRes.err) return createdBeforeRes.err;

    const page = await services.environments.listPage({
      tenantId: t,
      limit,
      ...(cursor ? { cursor } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(q ? { q } : {}),
      ...(createdAfterRes.value !== undefined
        ? { createdAfter: createdAfterRes.value }
        : {}),
      ...(createdBeforeRes.value !== undefined
        ? { createdBefore: createdBeforeRes.value }
        : {}),
    });
    return c.json({
      data: page.items.map(toEnvironmentConfig),
      ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}),
      has_more: !!page.nextCursor,
    });
  });

  // GET /v1/environments/:id — get environment
  app.get("/:id", async (c) => {
    const services = resolveServices(deps.services, c);
    if (!services.environments) {
      return c.json({ error: "environments service not configured" }, 500);
    }
    const row = await services.environments.get({
      tenantId: c.var.tenant_id,
      environmentId: c.req.param("id"),
    });
    if (!row) return c.json({ error: "Environment not found" }, 404);
    return c.json(toEnvironmentConfig(row));
  });

  // PUT (and POST) /v1/environments/:id — update environment.
  // POST alias mirrors the Anthropic Managed-Agents SDK convention.
  app.on(["PUT", "POST"], "/:id", async (c) => {
    const services = resolveServices(deps.services, c);
    if (!services.environments) {
      return c.json({ error: "environments service not configured" }, 500);
    }
    const t = c.var.tenant_id;
    const id = c.req.param("id");
    const existing = await services.environments.get({ tenantId: t, environmentId: id });
    if (!existing) return c.json({ error: "Environment not found" }, 404);

    const body = (await c.req.json()) as {
      name?: string;
      description?: string;
      config?: EnvironmentConfig["config"];
      metadata?: Record<string, unknown>;
    };

    const limitCheck = validateEnvironmentLimits(body);
    if (!limitCheck.ok) {
      return c.json({ error: limitCheck.error }, 400);
    }

    const patch: Parameters<typeof services.environments.update>[0] = {
      tenantId: t,
      environmentId: id,
    };
    if (body.name !== undefined) patch.name = body.name;
    if (body.description !== undefined) patch.description = body.description;
    if (body.config !== undefined) patch.config = body.config;
    if (body.metadata !== undefined) patch.metadata = body.metadata;

    const row = await services.environments.update(patch);
    return c.json(toEnvironmentConfig(row));
  });

  // POST /v1/environments/:id/archive
  app.post("/:id/archive", async (c) => {
    const services = resolveServices(deps.services, c);
    if (!services.environments) {
      return c.json({ error: "environments service not configured" }, 500);
    }
    const t = c.var.tenant_id;
    const id = c.req.param("id");
    try {
      const row = await services.environments.archive({ tenantId: t, environmentId: id });
      return c.json(toEnvironmentConfig(row));
    } catch (err) {
      if (err instanceof EnvironmentNotFoundError) {
        return c.json({ error: "Environment not found" }, 404);
      }
      throw err;
    }
  });

  // DELETE /v1/environments/:id — hard delete. Refuses (409) while the
  // environment still has active sessions.
  app.delete("/:id", async (c) => {
    const services = resolveServices(deps.services, c);
    if (!services.environments) {
      return c.json({ error: "environments service not configured" }, 500);
    }
    const t = c.var.tenant_id;
    const id = c.req.param("id");
    try {
      const hasActiveSessions = await services.sessions.hasActiveByEnvironment({
        tenantId: t,
        environmentId: id,
      });
      if (hasActiveSessions) {
        return c.json(
          {
            error:
              "Cannot delete environment with active sessions. Archive or delete sessions first.",
          },
          409,
        );
      }

      await services.environments.delete({ tenantId: t, environmentId: id });
      return c.json({ type: "environment_deleted", id });
    } catch (err) {
      if (err instanceof EnvironmentNotFoundError) {
        return c.json({ error: "Environment not found" }, 404);
      }
      throw err;
    }
  });

  return app;
}
