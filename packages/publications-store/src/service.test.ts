// Unit tests for the publications store service + in-memory repo.
// Covers CRUD, pagination, slug resolution (cross-tenant), and slug
// uniqueness conflict (issue #72).

import { describe, it, expect, beforeEach } from "vitest";
import { createInMemoryPublicationService, SequentialPublicationIdGenerator } from "./test-fakes";
import { PublicationSlugConflictError } from "./errors";

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "agent-1",
    agentVersion: 3,
    slug: "duyetbot",
    title: "Duyetbot",
    visibility: "public" as const,
    status: "live" as const,
    ...overrides,
  };
}

describe("PublicationService (in-memory)", () => {
  let svc: ReturnType<typeof createInMemoryPublicationService>["service"];

  beforeEach(() => {
    svc = createInMemoryPublicationService({
      ids: new SequentialPublicationIdGenerator(),
    }).service;
  });

  it("create stamps id + created_at and defaults", async () => {
    const row = await svc.create({ tenantId: TENANT_A, input: baseInput() });
    expect(row.id).toMatch(/^pub-/);
    expect(row.tenant_id).toBe(TENANT_A);
    expect(row.agent_id).toBe("agent-1");
    expect(row.agent_version).toBe(3);
    expect(row.slug).toBe("duyetbot");
    expect(row.visibility).toBe("public");
    expect(row.status).toBe("live");
    expect(row.suggested_prompts).toEqual([]);
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("getBySlug resolves cross-tenant without tenant scope", async () => {
    const row = await svc.create({ tenantId: TENANT_A, input: baseInput() });
    const bySlug = await svc.getBySlug({ slug: row.slug });
    expect(bySlug?.id).toBe(row.id);
    expect(bySlug?.tenant_id).toBe(TENANT_A);
    const missing = await svc.getBySlug({ slug: "nope" });
    expect(missing).toBeNull();
  });

  it("get is tenant-scoped", async () => {
    const row = await svc.create({ tenantId: TENANT_A, input: baseInput() });
    const own = await svc.get({ tenantId: TENANT_A, id: row.id });
    const other = await svc.get({ tenantId: TENANT_B, id: row.id });
    expect(own?.id).toBe(row.id);
    expect(other).toBeNull();
  });

  it("updates mutable fields", async () => {
    const row = await svc.create({ tenantId: TENANT_A, input: baseInput() });
    const updated = await svc.update({
      tenantId: TENANT_A,
      id: row.id,
      input: { status: "paused", title: "Renamed", suggestedPrompts: ["Hi", "Help?"] },
    });
    expect(updated.status).toBe("paused");
    expect(updated.title).toBe("Renamed");
    expect(updated.suggested_prompts).toEqual(["Hi", "Help?"]);
    expect(updated.slug).toBe("duyetbot");
  });

  it("slug update collides globally → PublicationSlugConflictError", async () => {
    await svc.create({ tenantId: TENANT_A, input: baseInput({ slug: "first" }) });
    const second = await svc.create({
      tenantId: TENANT_B,
      input: baseInput({ slug: "second", agentId: "agent-2" }),
    });
    await expect(
      svc.update({ tenantId: TENANT_B, id: second.id, input: { slug: "first" } }),
    ).rejects.toBeInstanceOf(PublicationSlugConflictError);
  });

  it("lists + paginates newest-first", async () => {
    await svc.create({ tenantId: TENANT_A, input: baseInput({ slug: "a" }) });
    await svc.create({ tenantId: TENANT_A, input: baseInput({ slug: "b" }) });
    await svc.create({ tenantId: TENANT_A, input: baseInput({ slug: "c" }) });
    const page1 = await svc.listPage({ tenantId: TENANT_A, limit: 2 });
    expect(page1.items.length).toBe(2);
    expect(page1.nextCursor).toBeDefined();
    const page2 = await svc.listPage({
      tenantId: TENANT_A,
      limit: 2,
      cursor: page1.nextCursor,
    });
    expect(page2.items.length).toBe(1);
    // newest first → c before b before a
    const ids = [...page1.items, ...page2.items].map((r) => r.slug);
    expect(ids).toEqual(["c", "b", "a"]);
  });

  it("delete removes the row; get returns null", async () => {
    const row = await svc.create({ tenantId: TENANT_A, input: baseInput() });
    await svc.delete({ tenantId: TENANT_A, id: row.id });
    expect(await svc.get({ tenantId: TENANT_A, id: row.id })).toBeNull();
    expect(await svc.getBySlug({ slug: row.slug })).toBeNull();
  });

  it("normalizes non-URL-safe slugs", async () => {
    const row = await svc.create({
      tenantId: TENANT_A,
      input: baseInput({ slug: "Duyet Bot!!" }),
    });
    expect(row.slug).toBe("duyet-bot");
    expect(await svc.getBySlug({ slug: "duyet-bot" })).not.toBeNull();
  });
});
