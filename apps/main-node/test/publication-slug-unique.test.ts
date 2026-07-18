// Issue #268: agent_publication.slug had no unique index on SQLite/D1 — two
// tenants could publish the same slug and /p/:slug resolution would be
// nondeterministic. This exercises the REAL migrations-sqlite migrator (not
// the in-memory fake) to prove migration 0006 actually installs a unique
// index that better-sqlite3 enforces.

import { describe, expect, it } from "vitest";
import { bootstrapTestDb } from "./_helpers/bootstrap-test-db";
import { createSqlitePublicationService } from "@duyet/oma-publications-store";
import { PublicationSlugConflictError } from "@duyet/oma-publications-store";

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "agent-1",
    agentVersion: 1,
    slug: "duyetbot",
    title: "Duyetbot",
    visibility: "public" as const,
    status: "live" as const,
    ...overrides,
  };
}

describe("agent_publication.slug unique index (SQLite)", () => {
  it("rejects a second tenant claiming the same slug", async () => {
    const { db, cleanup } = await bootstrapTestDb();
    try {
      const svc = createSqlitePublicationService({ db });
      await svc.create({ tenantId: "tenant-a", input: baseInput() });
      await expect(
        svc.create({
          tenantId: "tenant-b",
          input: baseInput({ agentId: "agent-2" }),
        }),
      ).rejects.toBeInstanceOf(PublicationSlugConflictError);
    } finally {
      cleanup();
    }
  });
});
