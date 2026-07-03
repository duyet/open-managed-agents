// Node-pool test for resolveTrustedProxyUser's find-or-create semantics
// against a real better-sqlite3 "user" table — the piece of trusted-proxy
// auth that touches a native driver and can't run under the root
// workers-pool suite (packages/auth/test covers the guard + middleware
// logic there instead, with fake in-memory deps).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyBetterAuthSchema } from "@duyet/oma-schema";
import { resolveTrustedProxyUser } from "@duyet/oma-auth-config";
import { BetterSqlite3SqlClient } from "@duyet/oma-sql-client/adapters/better-sqlite3";

let dir: string;
let db: import("better-sqlite3").Database;
let sql: BetterSqlite3SqlClient;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "oma-trusted-proxy-"));
  const BetterSqlite3 = (await import("better-sqlite3")).default;
  db = new BetterSqlite3(join(dir, "auth.db"));
  sql = new BetterSqlite3SqlClient(db);
  await applyBetterAuthSchema({ sql, dialect: "sqlite" });
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveTrustedProxyUser (sqlite)", () => {
  it("creates a new user row on first sight of an identity", async () => {
    const session = await resolveTrustedProxyUser(sql, "sqlite", {
      subject: "alice@example.com",
      email: "alice@example.com",
      name: "Alice",
    });
    expect(session.userId).toMatch(/^usr_/);
    expect(session.email).toBe("alice@example.com");
    expect(session.name).toBe("Alice");

    const row = await sql
      .prepare(`SELECT "id", "email", "emailVerified", "name" FROM "user" WHERE "email" = ?`)
      .bind("alice@example.com")
      .first<{ id: string; email: string; emailVerified: number; name: string }>();
    expect(row?.id).toBe(session.userId);
    // Trusted-proxy already vouched for the identity — treat as verified.
    expect(row?.emailVerified).toBe(1);
  });

  it("reuses the existing user row (find) on a second sighting of the same email", async () => {
    const first = await resolveTrustedProxyUser(sql, "sqlite", {
      subject: "bob@example.com",
      email: "bob@example.com",
      name: "Bob",
    });
    const second = await resolveTrustedProxyUser(sql, "sqlite", {
      subject: "bob@example.com",
      email: "bob@example.com",
      name: "Bob Ignored — should keep the first-created name",
    });
    expect(second.userId).toBe(first.userId);
    expect(second.name).toBe("Bob");

    const rows = await sql
      .prepare(`SELECT "id" FROM "user" WHERE "email" = ?`)
      .bind("bob@example.com")
      .all<{ id: string }>();
    expect(rows.results).toHaveLength(1);
  });

  it("lower-cases email for lookup/creation so casing differences don't create duplicate accounts", async () => {
    const created = await resolveTrustedProxyUser(sql, "sqlite", {
      subject: "Carol@Example.com",
      email: "Carol@Example.com",
      name: "Carol",
    });
    const again = await resolveTrustedProxyUser(sql, "sqlite", {
      subject: "carol@example.com",
      email: "carol@example.com",
      name: "Carol",
    });
    expect(again.userId).toBe(created.userId);
  });
});
