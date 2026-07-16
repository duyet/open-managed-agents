import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { env } from "cloudflare:workers";
import {
  scheduledDeploymentRunsTick,
  type ClaimedDeployment,
  type RecordDeploymentRunInput,
  type ScheduledDeploymentRunsStore,
  type ScheduledDeploymentRunLauncher,
} from "./scheduled-deployment-runs";
import { SqlClientScheduledDeploymentRunsStore } from "./scheduled-deployment-runs-store";
import { CfD1SqlClient } from "@duyet/oma-sql-client/adapters/cf-d1";
import { Cron } from "croner";
import { computeNextRunWith, type CronCtor } from "./scheduled-agent-runs";
import type { SqlClient, SqlStatement } from "@duyet/oma-sql-client";
// The ACTUAL deployments migration — the source of truth for the schema the
// claim SQL runs against. Importing it (rather than an inlined CREATE TABLE)
// is what makes the real-schema test below catch a SELECT of a column the
// migration doesn't define (e.g. the phantom `timezone` column bug).
// @ts-expect-error ?raw is a Vite string import, no type decl
import deploymentsMigration from "../../../../apps/main/migrations/0023_deployments.sql?raw";

const compute = (cron: string, tz: string, fromMs: number) =>
  computeNextRunWith(Cron as unknown as CronCtor, cron, tz, fromMs);

// ─── Faithful in-memory store mirroring the SqlClient CAS claim ──────────────

interface Row {
  id: string;
  tenantId: string;
  agentId: string;
  agentVersion: number | null;
  environmentId: string | null;
  userId: string | null;
  vaultIds: string[];
  memoryStoreIds: string[];
  cron: string;
  timezone: string;
  initialMessage: string;
  enabled: boolean;
  nextRunAt: number | null;
  lastRun?: RecordDeploymentRunInput;
}

class FakeStore implements ScheduledDeploymentRunsStore {
  constructor(
    public rows: Row[],
    private readonly yield_ = false,
  ) {}

  async claimDue(
    nowMs: number,
    limit: number,
    computeNextRun: (cron: string, timezone: string, fromMs: number) => number | null,
  ): Promise<ClaimedDeployment[]> {
    const due = this.rows
      .filter((r) => r.enabled && r.nextRunAt != null && r.nextRunAt <= nowMs)
      .slice(0, limit)
      .map((r) => ({ row: r, observed: r.nextRunAt }));

    const claimed: ClaimedDeployment[] = [];
    for (const { row, observed } of due) {
      const next = computeNextRun(row.cron, row.timezone, nowMs);
      if (this.yield_) await Promise.resolve();
      if (row.nextRunAt !== observed) continue;
      row.nextRunAt = next;
      claimed.push({
        id: row.id,
        tenantId: row.tenantId,
        agentId: row.agentId,
        agentVersion: row.agentVersion,
        environmentId: row.environmentId,
        userId: row.userId,
        vaultIds: row.vaultIds,
        memoryStoreIds: row.memoryStoreIds,
        cron: row.cron,
        timezone: row.timezone,
        initialMessage: row.initialMessage,
      });
    }
    return claimed;
  }

  async recordRun(id: string, input: RecordDeploymentRunInput): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (row) row.lastRun = input;
  }
}

function row(over: Partial<Row> = {}): Row {
  return {
    id: "dep_1",
    tenantId: "t1",
    agentId: "agent_1",
    agentVersion: null,
    environmentId: "env_1",
    userId: "user_1",
    vaultIds: [],
    memoryStoreIds: [],
    cron: "*/5 * * * *",
    timezone: "UTC",
    initialMessage: "run me",
    enabled: true,
    nextRunAt: Date.UTC(2026, 0, 1, 0, 0, 0),
    ...over,
  };
}

const NOW = Date.UTC(2026, 0, 1, 0, 1, 0);

describe("claimDue — due selection", () => {
  it("selects only enabled rows whose next_run_at is due", async () => {
    const store = new FakeStore([
      row({ id: "due" }),
      row({ id: "future", nextRunAt: Date.UTC(2026, 0, 2, 0, 0, 0) }),
      row({ id: "disabled", enabled: false }),
      row({ id: "no-next", nextRunAt: null }),
    ]);
    const claimed = await store.claimDue(NOW, 50, compute);
    expect(claimed.map((c) => c.id)).toEqual(["due"]);
  });

  it("carries the deployment bundle (vaults, memory stores, pinned version) into the claim", async () => {
    const store = new FakeStore([
      row({ id: "due", agentVersion: 3, vaultIds: ["vlt_a"], memoryStoreIds: ["ms_a", "ms_b"] }),
    ]);
    const [claimed] = await store.claimDue(NOW, 50, compute);
    expect(claimed.agentVersion).toBe(3);
    expect(claimed.vaultIds).toEqual(["vlt_a"]);
    expect(claimed.memoryStoreIds).toEqual(["ms_a", "ms_b"]);
    expect(claimed.initialMessage).toBe("run me");
  });

  it("advances next_run_at so a second tick at the same instant re-selects nothing", async () => {
    const store = new FakeStore([row({ id: "due" })]);
    const first = await store.claimDue(NOW, 50, compute);
    const second = await store.claimDue(NOW, 50, compute);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    expect(store.rows[0].nextRunAt).toBeGreaterThan(NOW);
  });
});

describe("claimDue — idempotent under concurrent ticks", () => {
  it("two overlapping ticks racing the same row claim it exactly once", async () => {
    const store = new FakeStore([row({ id: "due" })], /* yield_ */ true);
    const [a, b] = await Promise.all([
      store.claimDue(NOW, 50, compute),
      store.claimDue(NOW, 50, compute),
    ]);
    expect(a.length + b.length).toBe(1);
  });
});

// ─── tick loop: fires claimed deployments, fail-open per row ─────────────────

class FakeLauncher implements ScheduledDeploymentRunLauncher {
  launched: string[] = [];
  constructor(private readonly failIds: Set<string> = new Set()) {}
  async launch(dep: ClaimedDeployment): Promise<{ sessionId: string }> {
    this.launched.push(dep.id);
    if (this.failIds.has(dep.id)) throw new Error("boom");
    return { sessionId: `sess_${dep.id}` };
  }
}

describe("scheduledDeploymentRunsTick", () => {
  let store: FakeStore;
  beforeEach(() => {
    store = new FakeStore([
      row({ id: "a", nextRunAt: Date.UTC(2026, 0, 1, 0, 0, 0) }),
      row({ id: "b", nextRunAt: Date.UTC(2026, 0, 1, 0, 0, 0) }),
    ]);
  });

  it("fires each due deployment once and records success", async () => {
    const launcher = new FakeLauncher();
    const tick = scheduledDeploymentRunsTick({
      resolveStore: async () => store,
      resolveLauncher: async () => launcher,
      now: () => NOW,
    });
    await tick();
    expect(launcher.launched.sort()).toEqual(["a", "b"]);
    expect(store.rows.find((r) => r.id === "a")!.lastRun).toMatchObject({
      status: "ok",
      sessionId: "sess_a",
    });
  });

  it("is fail-open: a failing deployment records error but doesn't block others", async () => {
    const launcher = new FakeLauncher(new Set(["a"]));
    const tick = scheduledDeploymentRunsTick({
      resolveStore: async () => store,
      resolveLauncher: async () => launcher,
      now: () => NOW,
    });
    await tick();
    expect(store.rows.find((r) => r.id === "a")!.lastRun).toMatchObject({ status: "error" });
    expect(store.rows.find((r) => r.id === "b")!.lastRun).toMatchObject({ status: "ok" });
  });

  it("no-ops cleanly when store/launcher resolve to null", async () => {
    const tick = scheduledDeploymentRunsTick({
      resolveStore: async () => null,
      resolveLauncher: async () => null,
    });
    await expect(tick()).resolves.toBeUndefined();
  });
});

// ─── SqlClient store: parses trigger cron + JSON id arrays, CAS claim ────────

/** Minimal fake SqlClient: canned SELECT rows + records UPDATE binds. */
class FakeSqlClient implements SqlClient {
  updates: unknown[][] = [];
  constructor(private readonly selectRows: unknown[]) {}
  prepare(sql: string): SqlStatement {
    const isSelect = /^\s*SELECT/i.test(sql);
    const rows = this.selectRows;
    const updates = this.updates;
    let bound: unknown[] = [];
    const stmt: SqlStatement = {
      bind(...params: unknown[]) {
        bound = params;
        return stmt;
      },
      async run<T = unknown>() {
        if (!isSelect) updates.push(bound);
        return { meta: { changes: 1 } } as never as import("@duyet/oma-sql-client").SqlRunResult<T>;
      },
      async first<T = unknown>() {
        return (rows[0] ?? null) as T | null;
      },
      async all<T = unknown>() {
        return { results: rows as T[] } as never;
      },
    };
    return stmt;
  }
  async batch<T = unknown>() {
    return [] as never as Array<import("@duyet/oma-sql-client").SqlRunResult<T>>;
  }
  async exec() {}
}

describe("SqlClientScheduledDeploymentRunsStore.claimDue", () => {
  it("extracts cron from the trigger JSON and parses id arrays", async () => {
    const nowMs = NOW;
    const client = new FakeSqlClient([
      {
        id: "dep_1",
        tenant_id: "t1",
        agent_id: "agent_1",
        agent_version: 2,
        environment_id: "env_1",
        user_id: "user_1",
        vault_ids: '["vlt_a"]',
        memory_store_ids: '["ms_a"]',
        initial_message: "hi",
        // timezone lives INSIDE the trigger JSON — there is no `timezone`
        // column on `deployments` (see the real-schema test below).
        trigger: '{"type":"schedule","cron_expression":"*/5 * * * *","timezone":"America/New_York"}',
        next_run_at: new Date(Date.UTC(2026, 0, 1, 0, 0, 0)).toISOString(),
      },
    ]);
    const store = new SqlClientScheduledDeploymentRunsStore(client);
    const claimed = await store.claimDue(nowMs, 50, compute);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      id: "dep_1",
      agentVersion: 2,
      vaultIds: ["vlt_a"],
      memoryStoreIds: ["ms_a"],
      cron: "*/5 * * * *",
      // timezone comes out of the trigger JSON, not a column.
      timezone: "America/New_York",
      initialMessage: "hi",
    });
    // CAS UPDATE fired with the advanced next_run_at as first bind.
    expect(client.updates.length).toBe(1);
  });
});

// ─── Real-schema claim: runs the actual claim SQL against a table created ────
// from the real 0023_deployments.sql migration on the D1 MAIN_DB binding.
//
// This is the test that would have caught the phantom `timezone` column: the
// FakeSqlClient above happily returns whatever columns the fake row carries,
// so a `SELECT ... timezone ...` that references a non-existent column never
// surfaces there. Here the schema is the migration itself, so selecting a
// column the migration doesn't define throws "no such column" — exactly the
// runtime failure that broke every scheduled deployment run.

const d1 = () => (env as unknown as { MAIN_DB: D1Database }).MAIN_DB;

/** Apply the real migration file to the D1 binding (idempotent — the
 *  migration uses CREATE TABLE/INDEX IF NOT EXISTS). D1's exec wants
 *  comment-free, one-statement-per-line SQL, so normalize the file. */
async function applyDeploymentsMigration(): Promise<void> {
  const sql = (deploymentsMigration as string)
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .map((s) => `${s};`)
    .join("\n");
  await d1().exec(sql);
}

describe("SqlClientScheduledDeploymentRunsStore.claimDue — real 0023 schema", () => {
  beforeAll(applyDeploymentsMigration);
  beforeEach(async () => {
    await d1().prepare("DELETE FROM deployments").run();
  });

  async function insertScheduleRow(over: Record<string, unknown> = {}): Promise<void> {
    const nowIso = new Date().toISOString();
    const r = {
      id: "dep_real",
      tenant_id: "t1",
      name: "nightly",
      agent_id: "agent_1",
      agent_version: 2 as number | null,
      environment_id: "env_1",
      vault_ids: '["vlt_a"]',
      memory_store_ids: '["ms_a"]',
      initial_message: "hi",
      trigger: '{"type":"schedule","cron_expression":"*/5 * * * *","timezone":"America/New_York"}',
      user_id: "user_1" as string | null,
      enabled: 1,
      // Due at epoch so any NOW selects it.
      next_run_at: new Date(Date.UTC(2026, 0, 1, 0, 0, 0)).toISOString(),
      ...over,
    };
    await d1()
      .prepare(
        `INSERT INTO deployments
           (id, tenant_id, name, agent_id, agent_version, environment_id, vault_ids,
            memory_store_ids, initial_message, trigger, user_id, enabled, next_run_at,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        r.id,
        r.tenant_id,
        r.name,
        r.agent_id,
        r.agent_version,
        r.environment_id,
        r.vault_ids,
        r.memory_store_ids,
        r.initial_message,
        r.trigger,
        r.user_id,
        r.enabled,
        r.next_run_at,
        nowIso,
        nowIso,
      )
      .run();
  }

  it("claims a due schedule row and reads cron + timezone from the trigger JSON", async () => {
    await insertScheduleRow();
    const store = new SqlClientScheduledDeploymentRunsStore(new CfD1SqlClient(d1()));
    const claimed = await store.claimDue(Date.UTC(2026, 0, 1, 0, 1, 0), 50, compute);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      id: "dep_real",
      agentVersion: 2,
      environmentId: "env_1",
      userId: "user_1",
      vaultIds: ["vlt_a"],
      memoryStoreIds: ["ms_a"],
      cron: "*/5 * * * *",
      timezone: "America/New_York",
      initialMessage: "hi",
    });
    // CAS advanced next_run_at to the next occurrence.
    const after = await d1()
      .prepare("SELECT next_run_at FROM deployments WHERE id = ?")
      .bind("dep_real")
      .first<{ next_run_at: string }>();
    expect(new Date(after!.next_run_at).getTime()).toBeGreaterThan(Date.UTC(2026, 0, 1, 0, 1, 0));
  });

  it("skips a non-due future row", async () => {
    await insertScheduleRow({
      id: "dep_future",
      next_run_at: new Date(Date.UTC(2999, 0, 1)).toISOString(),
    });
    const store = new SqlClientScheduledDeploymentRunsStore(new CfD1SqlClient(d1()));
    const claimed = await store.claimDue(Date.UTC(2026, 0, 1, 0, 1, 0), 50, compute);
    expect(claimed).toHaveLength(0);
  });
});
