// Route-level coverage for publications' environment_id binding (issue #225).
//
// Publications now carry an optional environment_id (mirrors how
// deployments carry a required one) so POST /p/:slug/sessions can forward it
// for cloud agents. Covers: publish (top-level + agent-scoped) with a valid
// environment_id, 404 on a nonexistent/foreign-tenant environment_id, the
// field defaulting to null when omitted, and PATCH set/clear.

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  createInMemoryPublicationService,
  SequentialPublicationIdGenerator,
} from "@duyet/oma-publications-store/test-fakes";
import { createInMemoryEnvironmentService } from "@duyet/oma-environments-store/test-fakes";
import { createInMemoryAgentService } from "@duyet/oma-agents-store/test-fakes";
import { buildPublicationRoutes, buildAgentPublicationRoutes } from "./index";
import type { RouteServicesArg } from "../types";

const TENANT = "tenant-a";
const OTHER_TENANT = "tenant-b";

function makeServices() {
  const { service: publications } = createInMemoryPublicationService({
    ids: new SequentialPublicationIdGenerator(),
  });
  const { service: environments } = createInMemoryEnvironmentService();
  const { service: agents } = createInMemoryAgentService();
  const services = { publications, environments, agents } as unknown as RouteServicesArg;
  return { services, publications, environments, agents };
}

function withTenant(app: Hono<any>, tenantId = TENANT) {
  const wrapper = new Hono<{ Variables: { tenant_id: string } }>();
  wrapper.use("*", async (c, next) => {
    c.set("tenant_id", tenantId);
    await next();
  });
  wrapper.route("/", app);
  return wrapper;
}

function json(body: unknown, method = "POST"): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

describe("POST /v1/publications — environment_id (issue #225)", () => {
  it("publishes with a valid environment_id", async () => {
    const { services, agents, environments } = makeServices();
    const agent = await agents.create({ tenantId: TENANT, input: { name: "A", model: "claude-sonnet-4-6" } });
    const env = await environments.create({ tenantId: TENANT, name: "prod", config: { type: "cloud" } });
    const app = withTenant(buildPublicationRoutes({ services }));

    const res = await app.request(
      "/",
      json({ agent_id: agent.id, slug: "duyetbot", title: "Duyetbot", environment_id: env.id }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { environment_id: string | null };
    expect(body.environment_id).toBe(env.id);
  });

  it("defaults environment_id to null when omitted", async () => {
    const { services, agents } = makeServices();
    const agent = await agents.create({ tenantId: TENANT, input: { name: "A", model: "claude-sonnet-4-6" } });
    const app = withTenant(buildPublicationRoutes({ services }));

    const res = await app.request("/", json({ agent_id: agent.id, slug: "duyetbot", title: "Duyetbot" }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { environment_id: string | null };
    expect(body.environment_id).toBeNull();
  });

  it("404s a nonexistent environment_id", async () => {
    const { services, agents } = makeServices();
    const agent = await agents.create({ tenantId: TENANT, input: { name: "A", model: "claude-sonnet-4-6" } });
    const app = withTenant(buildPublicationRoutes({ services }));

    const res = await app.request(
      "/",
      json({ agent_id: agent.id, slug: "duyetbot", title: "Duyetbot", environment_id: "env-missing" }),
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toMatch(/Environment not found/);
  });

  it("404s an environment_id that belongs to a different tenant", async () => {
    const { services, agents, environments } = makeServices();
    const agent = await agents.create({ tenantId: TENANT, input: { name: "A", model: "claude-sonnet-4-6" } });
    const foreignEnv = await environments.create({
      tenantId: OTHER_TENANT,
      name: "prod",
      config: { type: "cloud" },
    });
    const app = withTenant(buildPublicationRoutes({ services }));

    const res = await app.request(
      "/",
      json({ agent_id: agent.id, slug: "duyetbot", title: "Duyetbot", environment_id: foreignEnv.id }),
    );
    expect(res.status).toBe(404);
  });

  it("does not persist a publication when environment validation fails", async () => {
    const { services, agents, publications } = makeServices();
    const agent = await agents.create({ tenantId: TENANT, input: { name: "A", model: "claude-sonnet-4-6" } });
    const app = withTenant(buildPublicationRoutes({ services }));

    await app.request(
      "/",
      json({ agent_id: agent.id, slug: "duyetbot", title: "Duyetbot", environment_id: "env-missing" }),
    );
    const rows = await publications.list({ tenantId: TENANT });
    expect(rows).toHaveLength(0);
  });
});

describe("agent-scoped publish + patch — environment_id (issue #225)", () => {
  function agentPubApp(services: RouteServicesArg) {
    const app = new Hono();
    app.route("/agents/:id/publications", buildAgentPublicationRoutes({ services }, "id"));
    return withTenant(app);
  }

  it("POST /agents/:id/publications accepts environment_id", async () => {
    const { services, agents, environments } = makeServices();
    const agent = await agents.create({ tenantId: TENANT, input: { name: "A", model: "claude-sonnet-4-6" } });
    const env = await environments.create({ tenantId: TENANT, name: "prod", config: { type: "cloud" } });
    const app = agentPubApp(services);

    const res = await app.request(
      `/agents/${agent.id}/publications`,
      json({ slug: "duyetbot", title: "Duyetbot", environment_id: env.id }),
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as { environment_id: string }).environment_id).toBe(env.id);
  });

  it("PATCH /agents/:id/publications/:pid sets environment_id", async () => {
    const { services, agents, environments } = makeServices();
    const agent = await agents.create({ tenantId: TENANT, input: { name: "A", model: "claude-sonnet-4-6" } });
    const app = agentPubApp(services);
    const created = (await (
      await app.request(`/agents/${agent.id}/publications`, json({ slug: "duyetbot", title: "Duyetbot" }))
    ).json()) as { id: string; environment_id: string | null };
    expect(created.environment_id).toBeNull();

    // Seed the environment on the SAME services bundle used by the app.
    const env = await environments.create({ tenantId: TENANT, name: "prod", config: { type: "cloud" } });

    const res = await app.request(
      `/agents/${agent.id}/publications/${created.id}`,
      json({ environment_id: env.id }, "PATCH"),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { environment_id: string }).environment_id).toBe(env.id);
  });

  it("PATCH rejects a nonexistent environment_id with 404 and leaves the row untouched", async () => {
    const { services, agents } = makeServices();
    const agent = await agents.create({ tenantId: TENANT, input: { name: "A", model: "claude-sonnet-4-6" } });
    const app = agentPubApp(services);
    const created = (await (
      await app.request(`/agents/${agent.id}/publications`, json({ slug: "duyetbot", title: "Duyetbot" }))
    ).json()) as { id: string };

    const res = await app.request(
      `/agents/${agent.id}/publications/${created.id}`,
      json({ environment_id: "env-missing" }, "PATCH"),
    );
    expect(res.status).toBe(404);

    const stillNull = (await (
      await app.request(`/agents/${agent.id}/publications/${created.id}`)
    ).json()) as { environment_id: string | null };
    expect(stillNull.environment_id).toBeNull();
  });

  it("PATCH clears environment_id by passing null", async () => {
    const { services, agents, environments } = makeServices();
    const agent = await agents.create({ tenantId: TENANT, input: { name: "A", model: "claude-sonnet-4-6" } });
    const env = await environments.create({ tenantId: TENANT, name: "prod", config: { type: "cloud" } });
    const app = agentPubApp(services);
    const created = (await (
      await app.request(
        `/agents/${agent.id}/publications`,
        json({ slug: "duyetbot", title: "Duyetbot", environment_id: env.id }),
      )
    ).json()) as { id: string };

    const res = await app.request(
      `/agents/${agent.id}/publications/${created.id}`,
      json({ environment_id: null }, "PATCH"),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { environment_id: string | null }).environment_id).toBeNull();
  });
});
