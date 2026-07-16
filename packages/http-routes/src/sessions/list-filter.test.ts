// Route-level coverage for the sessions list handler's created_after /
// created_before date-range filter (previously silently ignored) plus the
// input_tokens / output_tokens fields on session list + GET responses.

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  createInMemorySessionService,
  ManualClock,
  type InMemorySessionRepo,
} from "@duyet/oma-sessions-store/test-fakes";
import type { SessionService } from "@duyet/oma-sessions-store";
import { buildSessionRoutes } from "./index";
import type { SessionRouter } from "@duyet/oma-session-runtime";
import type { RouteServices } from "../types";

const TENANT = "tenant-1";
const DAY = 86_400_000;
const BASE = Date.UTC(2026, 0, 1, 0, 0, 0); // 2026-01-01

async function seed(
  repo: InMemorySessionRepo,
  s: { id: string; createdAt: number; input?: number; output?: number },
) {
  await repo.insertWithResources(
    {
      id: s.id,
      tenantId: TENANT,
      agentId: "agent_1",
      environmentId: "env_1",
      title: s.id,
      status: "idle",
      vaultIds: null,
      agentSnapshot: null,
      environmentSnapshot: null,
      metadata: null,
      createdAt: s.createdAt,
    },
    [],
  );
  if (s.input !== undefined || s.output !== undefined) {
    await repo.update(TENANT, s.id, {
      inputTokens: s.input ?? 0,
      outputTokens: s.output ?? 0,
      updatedAt: s.createdAt,
    });
  }
}

function makeApp(service: SessionService) {
  const app = new Hono<{ Variables: { tenant_id: string } }>();
  app.use("*", async (c, next) => {
    c.set("tenant_id", TENANT);
    await next();
  });
  app.route(
    "/v1/sessions",
    buildSessionRoutes({
      services: { sessions: service } as unknown as RouteServices,
      // GET /:id calls router.getFullStatus; the list route never touches it.
      router: { getFullStatus: async () => null } as unknown as SessionRouter,
    }),
  );
  return app;
}

describe("GET /v1/sessions created_after / created_before filter", () => {
  it("filters to the created_after..created_before window", async () => {
    const { service, repo } = createInMemorySessionService({ clock: new ManualClock(BASE) });
    await seed(repo, { id: "jan01", createdAt: BASE });
    await seed(repo, { id: "jan05", createdAt: BASE + 5 * DAY });
    await seed(repo, { id: "jan10", createdAt: BASE + 10 * DAY });

    const after = new Date(BASE + 3 * DAY).toISOString();
    const before = new Date(BASE + 8 * DAY).toISOString();
    const res = await makeApp(service).request(
      `/v1/sessions?created_after=${after}&created_before=${before}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const ids = (body.data as Array<{ id: string }>).map((s) => s.id);
    expect(ids).toEqual(["jan05"]);
  });

  it("created_after is inclusive, created_before is exclusive", async () => {
    const { service, repo } = createInMemorySessionService({ clock: new ManualClock(BASE) });
    await seed(repo, { id: "boundary_lo", createdAt: BASE + 2 * DAY });
    await seed(repo, { id: "boundary_hi", createdAt: BASE + 8 * DAY });
    const after = new Date(BASE + 2 * DAY).toISOString();
    const before = new Date(BASE + 8 * DAY).toISOString();
    const res = await makeApp(service).request(
      `/v1/sessions?created_after=${after}&created_before=${before}`,
    );
    const ids = ((await res.json()) as any).data.map((s: { id: string }) => s.id);
    expect(ids).toContain("boundary_lo"); // == after → included
    expect(ids).not.toContain("boundary_hi"); // == before → excluded
  });

  it("rejects an unparseable created_after with 400", async () => {
    const { service } = createInMemorySessionService({ clock: new ManualClock(BASE) });
    const res = await makeApp(service).request("/v1/sessions?created_after=not-a-date");
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("invalid_timestamp");
  });

  it("no date params → unfiltered (all sessions returned)", async () => {
    const { service, repo } = createInMemorySessionService({ clock: new ManualClock(BASE) });
    await seed(repo, { id: "a", createdAt: BASE });
    await seed(repo, { id: "b", createdAt: BASE + 100 * DAY });
    const res = await makeApp(service).request("/v1/sessions");
    const ids = ((await res.json()) as any).data.map((s: { id: string }) => s.id);
    expect(ids.sort()).toEqual(["a", "b"]);
  });
});

describe("session responses expose input_tokens / output_tokens", () => {
  it("list includes token fields", async () => {
    const { service, repo } = createInMemorySessionService({ clock: new ManualClock(BASE) });
    await seed(repo, { id: "s1", createdAt: BASE, input: 123, output: 45 });
    const res = await makeApp(service).request("/v1/sessions");
    const row = ((await res.json()) as any).data[0];
    expect(row.input_tokens).toBe(123);
    expect(row.output_tokens).toBe(45);
  });

  it("GET :id includes token fields (defaulting to 0)", async () => {
    const { service, repo } = createInMemorySessionService({ clock: new ManualClock(BASE) });
    await seed(repo, { id: "s2", createdAt: BASE });
    const res = await makeApp(service).request("/v1/sessions/s2");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.input_tokens).toBe(0);
    expect(body.output_tokens).toBe(0);
  });

  it("addTokenUsage increments cumulatively (reportUsage sink) and surfaces in list", async () => {
    const { service, repo } = createInMemorySessionService({ clock: new ManualClock(BASE) });
    await seed(repo, { id: "s3", createdAt: BASE });
    // Two per-turn deltas — the sink is additive, not absolute.
    await service.addTokenUsage({ tenantId: TENANT, sessionId: "s3", inputTokens: 100, outputTokens: 20 });
    await service.addTokenUsage({ tenantId: TENANT, sessionId: "s3", inputTokens: 50, outputTokens: 30 });
    const res = await makeApp(service).request("/v1/sessions");
    const row = ((await res.json()) as any).data.find((r: { id: string }) => r.id === "s3");
    expect(row.input_tokens).toBe(150);
    expect(row.output_tokens).toBe(50);
  });
});
