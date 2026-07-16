import { describe, it, expect, beforeEach } from "vitest";
import { Cron } from "croner";
import {
  computeNextRunWith,
  scheduledAgentRunsTick,
  type ClaimedSchedule,
  type RecordRunInput,
  type ScheduledRunsStore,
  type ScheduledRunLauncher,
  type CronCtor,
} from "./scheduled-agent-runs";

const compute = (cron: string, tz: string, fromMs: number) =>
  computeNextRunWith(Cron as unknown as CronCtor, cron, tz, fromMs);

// ─── next_run recompute (incl. DST boundary) ────────────────────────────────

describe("computeNextRun", () => {
  it("advances to the next occurrence of a daily cron (UTC)", () => {
    const from = Date.UTC(2026, 0, 1, 12, 0, 0); // 2026-01-01T12:00Z
    const next = compute("0 15 * * *", "UTC", from);
    expect(next).toBe(Date.UTC(2026, 0, 1, 15, 0, 0));
  });

  it("returns null for a cron that never fires (Feb 30)", () => {
    const from = Date.UTC(2026, 0, 1, 0, 0, 0);
    expect(compute("0 0 30 2 *", "UTC", from)).toBeNull();
  });

  it("returns null (not a throw) for an unparseable cron", () => {
    expect(compute("not a cron", "UTC", Date.now())).toBeNull();
  });

  it("recomputes correctly across a US spring-forward DST boundary", () => {
    // US DST 2026 begins 2026-03-08. A 09:30 America/New_York daily cron is
    // -05:00 (14:30Z) before the switch and -04:00 (13:30Z) after it. The
    // recompute must honor the zone, not a fixed offset.
    const tz = "America/New_York";
    const beforeDst = compute("30 9 * * *", tz, Date.UTC(2026, 2, 7, 0, 0, 0));
    const afterDst = compute("30 9 * * *", tz, Date.UTC(2026, 2, 9, 0, 0, 0));
    expect(beforeDst).not.toBeNull();
    expect(afterDst).not.toBeNull();
    expect(new Date(beforeDst!).getUTCHours()).toBe(14); // EST
    expect(new Date(afterDst!).getUTCHours()).toBe(13); // EDT
  });
});

// ─── Faithful in-memory store mirroring the SqlClient CAS claim ──────────────

interface Row {
  id: string;
  tenantId: string;
  agentId: string;
  environmentId: string | null;
  userId: string | null;
  cron: string;
  timezone: string;
  prompt: string;
  enabled: boolean;
  nextRunAt: number | null;
  lastRun?: RecordRunInput;
}

/** Models agent_schedules + the compare-and-set claim in-memory. `yield_`
 *  forces a microtask between select and CAS so two concurrent claimDue
 *  calls actually race (mirrors two overlapping cron ticks). */
class FakeStore implements ScheduledRunsStore {
  constructor(
    public rows: Row[],
    private readonly yield_ = false,
  ) {}

  async claimDue(
    nowMs: number,
    limit: number,
    computeNextRun: (cron: string, timezone: string, fromMs: number) => number | null,
  ): Promise<ClaimedSchedule[]> {
    const due = this.rows
      .filter((r) => r.enabled && r.nextRunAt != null && r.nextRunAt <= nowMs)
      .slice(0, limit)
      .map((r) => ({ row: r, observed: r.nextRunAt }));

    const claimed: ClaimedSchedule[] = [];
    for (const { row, observed } of due) {
      const next = computeNextRun(row.cron, row.timezone, nowMs);
      if (this.yield_) await Promise.resolve();
      // CAS: only claim if next_run_at is still what we selected.
      if (row.nextRunAt !== observed) continue;
      row.nextRunAt = next;
      claimed.push({
        id: row.id,
        tenantId: row.tenantId,
        agentId: row.agentId,
        environmentId: row.environmentId,
        userId: row.userId,
        cron: row.cron,
        timezone: row.timezone,
        prompt: row.prompt,
      });
    }
    return claimed;
  }

  async recordRun(id: string, input: RecordRunInput): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (row) row.lastRun = input;
  }
}

function row(over: Partial<Row> = {}): Row {
  return {
    id: "sch_1",
    tenantId: "t1",
    agentId: "agent_1",
    environmentId: "env_1",
    userId: "user_1",
    cron: "*/5 * * * *",
    timezone: "UTC",
    prompt: "daily digest",
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

  it("advances next_run_at so a second tick at the same instant re-selects nothing (idempotent)", async () => {
    const store = new FakeStore([row({ id: "due" })]);
    const first = await store.claimDue(NOW, 50, compute);
    const second = await store.claimDue(NOW, 50, compute);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    expect(store.rows[0].nextRunAt).toBeGreaterThan(NOW);
  });
});

describe("claimDue — idempotent claim under concurrent ticks", () => {
  it("two overlapping ticks racing the same row claim it exactly once", async () => {
    const store = new FakeStore([row({ id: "due" })], /* yield_ */ true);
    const [a, b] = await Promise.all([
      store.claimDue(NOW, 50, compute),
      store.claimDue(NOW, 50, compute),
    ]);
    const totalClaims = a.length + b.length;
    expect(totalClaims).toBe(1);
  });
});

// ─── tick loop: fires claimed schedules, fail-open per row ───────────────────

class FakeLauncher implements ScheduledRunLauncher {
  launched: string[] = [];
  constructor(private readonly failIds: Set<string> = new Set()) {}
  async launch(schedule: ClaimedSchedule): Promise<{ sessionId: string }> {
    this.launched.push(schedule.id);
    if (this.failIds.has(schedule.id)) throw new Error("boom");
    return { sessionId: `sess_${schedule.id}` };
  }
}

describe("scheduledAgentRunsTick", () => {
  let store: FakeStore;
  beforeEach(() => {
    store = new FakeStore([
      row({ id: "a", nextRunAt: Date.UTC(2026, 0, 1, 0, 0, 0) }),
      row({ id: "b", nextRunAt: Date.UTC(2026, 0, 1, 0, 0, 0) }),
    ]);
  });

  it("fires each due schedule once and records success", async () => {
    const launcher = new FakeLauncher();
    const tick = scheduledAgentRunsTick({
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

  it("is fail-open: a failing schedule records error but doesn't block others", async () => {
    const launcher = new FakeLauncher(new Set(["a"]));
    const tick = scheduledAgentRunsTick({
      resolveStore: async () => store,
      resolveLauncher: async () => launcher,
      now: () => NOW,
    });
    await tick();
    expect(store.rows.find((r) => r.id === "a")!.lastRun).toMatchObject({ status: "error" });
    expect(store.rows.find((r) => r.id === "b")!.lastRun).toMatchObject({ status: "ok" });
  });

  it("no-ops cleanly when store/launcher resolve to null", async () => {
    const tick = scheduledAgentRunsTick({
      resolveStore: async () => null,
      resolveLauncher: async () => null,
    });
    await expect(tick()).resolves.toBeUndefined();
  });
});
