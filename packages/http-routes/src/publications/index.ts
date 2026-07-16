// Publications — tenant-authed CRUD for the public chat surface (issue #72).
//
// Two mount shapes (both tenant-scoped via the surrounding auth middleware):
//   - buildPublicationRoutes(deps)            → mounted at /v1/publications
//   - buildAgentPublicationRoutes(deps, aid) → mounted at /v1/agents/:id/publications
//     (aid injected by the caller so the route body never reads the raw
//     path param from a different mount prefix).
//
// The actual session-create / SSE pass-throughs for the public surface live
// in apps/main/src/routes/publications.ts (they bypass x-api-key auth and
// resolve the tenant from the publication row). This file is purely the
// owner's management API.

import { Hono } from "hono";
import type { RouteServices, RouteServicesArg } from "../types";
import { resolveServices } from "../types";
import {
  PublicationNotFoundError,
  PublicationSlugConflictError,
} from "@duyet/oma-publications-store";

interface Vars {
  Variables: { tenant_id: string; user_id?: string };
}

function toApi(p: {
  id: string;
  tenant_id: string;
  agent_id: string;
  agent_version: number;
  slug: string;
  title: string;
  description: string | null;
  avatar_url: string | null;
  visibility: string;
  status: string;
  greeting: string | null;
  suggested_prompts: string[];
  pricing_ref: string | null;
  rate_limit_ref: string | null;
  environment_id: string | null;
  created_at: string;
}) {
  const { tenant_id: _t, ...rest } = p;
  return rest;
}

function mapError(c: import("hono").Context, err: unknown): Response {
  if (err instanceof PublicationNotFoundError) {
    return c.json({ error: "Publication not found" }, 404);
  }
  if (err instanceof PublicationSlugConflictError) {
    return c.json({ error: "Slug already in use" }, 409);
  }
  throw err;
}

/**
 * Validate an optional environment_id belongs to the tenant — mirrors
 * validateDeploymentRefs' environment check in apps/main/src/routes/deployments.ts.
 * Returns an error Response to surface, or null when environmentId is
 * unset/null (nothing to validate) or resolves. `services.environments` is
 * optional on RouteServices (legacy fixtures / hosts that don't wire it); if
 * a caller actually supplies an environment_id we can't verify, fail loud
 * (500) rather than silently persisting an unchecked reference — same
 * precedent as buildEnvironmentRoutes below.
 */
async function validateEnvironmentRef(
  c: import("hono").Context<Vars>,
  services: RouteServices,
  environmentId: string | null | undefined,
): Promise<Response | null> {
  if (!environmentId) return null;
  if (!services.environments) {
    return c.json({ error: "environments service not configured" }, 500);
  }
  const environment = await services.environments.get({
    tenantId: c.var.tenant_id,
    environmentId,
  });
  if (!environment) return c.json({ error: "Environment not found" }, 404);
  return null;
}

export interface PublicationRoutesDeps {
  services: RouteServicesArg;
}

/** Mount at /v1/publications — tenant-scoped list/create across all the
 *  tenant's publications (optionally filtered by agent_id). */
export function buildPublicationRoutes(deps: PublicationRoutesDeps) {
  const app = new Hono<Vars>();

  app.post("/", async (c) => {
    const services = resolveServices(deps.services, c);
    const body = await c.req.json<{
      agent_id: string;
      agent_version?: number;
      slug: string;
      title: string;
      description?: string | null;
      avatar_url?: string | null;
      visibility?: "public" | "unlisted" | "private";
      status?: "draft" | "live" | "paused";
      greeting?: string | null;
      suggested_prompts?: string[];
      pricing_ref?: string | null;
      rate_limit_ref?: string | null;
      environment_id?: string | null;
    }>();
    if (!body.agent_id) return c.json({ error: "agent_id is required" }, 400);
    if (!body.slug) return c.json({ error: "slug is required" }, 400);
    if (!body.title) return c.json({ error: "title is required" }, 400);

    const envErr = await validateEnvironmentRef(c, services, body.environment_id);
    if (envErr) return envErr;

    // Pin the published version: default to the agent's current version.
    let version = body.agent_version;
    if (version === undefined) {
      const agent = await services.agents.get({
        tenantId: c.var.tenant_id,
        agentId: body.agent_id,
      });
      if (!agent) return c.json({ error: "Agent not found" }, 404);
      version = (agent as unknown as { version: number }).version;
    }

    try {
      const row = await services.publications.create({
        tenantId: c.var.tenant_id,
        input: {
          agentId: body.agent_id,
          agentVersion: version,
          slug: body.slug,
          title: body.title,
          description: body.description ?? null,
          avatarUrl: body.avatar_url ?? null,
          visibility: body.visibility ?? "public",
          status: body.status ?? "draft",
          greeting: body.greeting ?? null,
          suggestedPrompts: body.suggested_prompts ?? [],
          pricingRef: body.pricing_ref ?? null,
          rateLimitRef: body.rate_limit_ref ?? null,
          environmentId: body.environment_id ?? null,
        },
      });
      return c.json(toApi(row), 201);
    } catch (err) {
      return mapError(c, err);
    }
  });

  app.get("/", async (c) => {
    const services = resolveServices(deps.services, c);
    const limitStr = c.req.query("limit");
    const limit = limitStr ? Math.min(Math.max(1, Number(limitStr)), 100) : 50;
    const cursor = c.req.query("cursor") ?? c.req.query("page") ?? undefined;
    const agentId = c.req.query("agent_id") || undefined;
    const page = await services.publications.listPage({
      tenantId: c.var.tenant_id,
      ...(agentId ? { agentId } : {}),
      limit,
      ...(cursor ? { cursor } : {}),
    });
    return c.json({
      data: page.items.map(toApi),
      ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}),
      has_more: !!page.nextCursor,
    });
  });

  return app;
}

/** Mount at /v1/agents/:id/publications — scoped to one agent. */
export function buildAgentPublicationRoutes(
  deps: PublicationRoutesDeps,
  agentIdParam: string,
) {
  const app = new Hono<Vars>();

  // List + create scoped to a single agent.
  app.get("/", async (c) => {
    const services = resolveServices(deps.services, c);
    const agentId = c.req.param(agentIdParam);
    if (!agentId) return c.json({ error: "agent_id is required" }, 400);
    const rows = await services.publications.list({
      tenantId: c.var.tenant_id,
      agentId,
    });
    return c.json({ data: rows.map(toApi) });
  });

  app.post("/", async (c) => {
    const services = resolveServices(deps.services, c);
    const agentId = c.req.param(agentIdParam);
    if (!agentId) return c.json({ error: "agent_id is required" }, 400);
    const agent = await services.agents.get({
      tenantId: c.var.tenant_id,
      agentId,
    });
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    const body = await c.req.json<{
      slug: string;
      title: string;
      description?: string | null;
      avatar_url?: string | null;
      visibility?: "public" | "unlisted" | "private";
      status?: "draft" | "live" | "paused";
      greeting?: string | null;
      suggested_prompts?: string[];
      pricing_ref?: string | null;
      rate_limit_ref?: string | null;
      environment_id?: string | null;
    }>();
    if (!body.slug) return c.json({ error: "slug is required" }, 400);
    if (!body.title) return c.json({ error: "title is required" }, 400);

    const envErr = await validateEnvironmentRef(c, services, body.environment_id);
    if (envErr) return envErr;

    try {
      const row = await services.publications.create({
        tenantId: c.var.tenant_id,
        input: {
          agentId,
          agentVersion: (agent as unknown as { version: number }).version,
          slug: body.slug,
          title: body.title,
          description: body.description ?? null,
          avatarUrl: body.avatar_url ?? null,
          visibility: body.visibility ?? "public",
          status: body.status ?? "draft",
          greeting: body.greeting ?? null,
          suggestedPrompts: body.suggested_prompts ?? [],
          pricingRef: body.pricing_ref ?? null,
          rateLimitRef: body.rate_limit_ref ?? null,
          environmentId: body.environment_id ?? null,
        },
      });
      return c.json(toApi(row), 201);
    } catch (err) {
      return mapError(c, err);
    }
  });

  // Per-publication GET/PATCH/DELETE by id (still agent-scoped).
  app.get("/:pid", async (c) => {
    const services = resolveServices(deps.services, c);
    const row = await services.publications.get({
      tenantId: c.var.tenant_id,
      id: c.req.param("pid"),
    });
    if (!row) return c.json({ error: "Publication not found" }, 404);
    return c.json(toApi(row));
  });

  app.patch("/:pid", async (c) => {
    const services = resolveServices(deps.services, c);
    const body = await c.req.json<{
      title?: string;
      description?: string | null;
      avatar_url?: string | null;
      visibility?: "public" | "unlisted" | "private";
      status?: "draft" | "live" | "paused";
      greeting?: string | null;
      suggested_prompts?: string[];
      pricing_ref?: string | null;
      rate_limit_ref?: string | null;
      environment_id?: string | null;
      slug?: string;
    }>();

    const envErr = await validateEnvironmentRef(c, services, body.environment_id);
    if (envErr) return envErr;

    try {
      const row = await services.publications.update({
        tenantId: c.var.tenant_id,
        id: c.req.param("pid"),
        input: {
          title: body.title,
          description: body.description,
          avatarUrl: body.avatar_url,
          visibility: body.visibility,
          status: body.status,
          greeting: body.greeting,
          suggestedPrompts: body.suggested_prompts,
          pricingRef: body.pricing_ref,
          rateLimitRef: body.rate_limit_ref,
          environmentId: body.environment_id,
          slug: body.slug,
        },
      });
      return c.json(toApi(row));
    } catch (err) {
      return mapError(c, err);
    }
  });

  app.delete("/:pid", async (c) => {
    const services = resolveServices(deps.services, c);
    try {
      await services.publications.delete({
        tenantId: c.var.tenant_id,
        id: c.req.param("pid"),
      });
      return c.json({ type: "publication_deleted", id: c.req.param("pid") });
    } catch (err) {
      return mapError(c, err);
    }
  });

  return app;
}
