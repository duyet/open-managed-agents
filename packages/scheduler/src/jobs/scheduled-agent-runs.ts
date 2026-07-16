// Scheduled agent runs — the user-facing "run this agent on a schedule"
// tick (issue #77).
//
// Each per-minute cron tick:
//   1. Selects due schedules (enabled AND next_run_at <= now).
//   2. Claims each row idempotently — a compare-and-set that advances
//      next_run_at to the *next* cron occurrence in the same statement.
//      Only the tick whose UPDATE matched the old next_run_at wins the
//      claim, so overlapping ticks or multiple Node replicas can't
//      double-fire the same occurrence.
//   3. Launches a session for the claimed schedule (the configured prompt
//      injected as a user.message — no human turn required), reusing the
//      host's existing session-creation path.
//   4. Records last_run status/error on the row.
//
// Fail-open per schedule: one bad row (bad cron, launch failure) is logged
// and skipped, never blocking the others. Mirrors linear-dispatch.ts.
//
// The store + launcher are ports so this stays host-agnostic and unit
// testable; the CF host wires the concrete SqlClient store (agent_schedules
// in MAIN_DB) and a launcher over the internal session-create path.

import { getLogger } from "@duyet/oma-observability";

const log = getLogger("scheduler.scheduled-agent-runs");

/** A schedule the tick has *claimed* and is responsible for firing once. */
export interface ClaimedSchedule {
  id: string;
  tenantId: string;
  agentId: string;
  environmentId: string | null;
  userId: string | null;
  cron: string;
  timezone: string;
  prompt: string;
}

export interface RecordRunInput {
  status: "ok" | "error";
  error?: string | null;
  sessionId?: string | null;
  ranAtMs: number;
}

export interface ScheduledRunsStore {
  /**
   * Atomically select-and-claim up to `limit` due schedules. The claim MUST
   * advance next_run_at to the next occurrence within the same compare-and-set
   * so a concurrent tick can't re-select the same row. Returns only the rows
   * this caller won.
   *
   * `computeNextRun` is passed in so the store can advance next_run_at from
   * the cron+timezone without owning cron parsing.
   */
  claimDue(
    nowMs: number,
    limit: number,
    computeNextRun: (cron: string, timezone: string, fromMs: number) => number | null,
  ): Promise<ClaimedSchedule[]>;

  /** Persist the outcome of a fired schedule (last_run_* columns). */
  recordRun(id: string, input: RecordRunInput): Promise<void>;
}

export interface ScheduledRunLauncher {
  /** Create a session for the schedule and inject `prompt` as a user.message.
   *  Returns the created session id. Throws on failure (caught per-row). */
  launch(schedule: ClaimedSchedule): Promise<{ sessionId: string }>;
}

export interface ScheduledAgentRunsTickDeps {
  /** Per-tick store resolver. Async so hosts can lazy-build. A thrown/`null`
   *  resolve is swallowed at the tick boundary; cron keeps ticking. */
  resolveStore: () => Promise<ScheduledRunsStore | null>;
  /** Per-tick launcher resolver. Same swallow semantics as `resolveStore`. */
  resolveLauncher: () => Promise<ScheduledRunLauncher | null>;
  /** Cap schedules fired per tick. Default 50. */
  limit?: number;
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number;
}

/**
 * Compute the next cron occurrence strictly after `fromMs`, honoring
 * `timezone` (IANA name, e.g. "America/New_York") so DST transitions land
 * correctly. Returns epoch ms, or null when the cron never fires again /
 * is unparseable.
 *
 * Uses `croner` (pure JS, runs identically on Workers and Node) via a lazy
 * import so consumers that never fire schedules don't pay for it.
 */
export async function computeNextRunAsync(
  cron: string,
  timezone: string,
  fromMs: number,
): Promise<number | null> {
  const { Cron } = await import(/* @vite-ignore */ "croner");
  return computeNextRunWith(Cron as CronCtor, cron, timezone, fromMs);
}

// The croner surface we depend on — kept minimal so the import shape is
// obvious and the sync helper below is trivially testable with a fake.
export interface CronInstanceLike {
  nextRun(from?: Date): Date | null;
}
export interface CronCtor {
  new (pattern: string, options: { timezone?: string }): CronInstanceLike;
}

export function computeNextRunWith(
  Cron: CronCtor,
  cron: string,
  timezone: string,
  fromMs: number,
): number | null {
  try {
    const c = new Cron(cron, { timezone: timezone || "UTC" });
    const next = c.nextRun(new Date(fromMs));
    return next ? next.getTime() : null;
  } catch (err) {
    log.warn({ err, cron, timezone, op: "scheduled-runs.bad_cron" }, "unparseable cron");
    return null;
  }
}

export function scheduledAgentRunsTick(deps: ScheduledAgentRunsTickDeps): () => Promise<void> {
  const limit = deps.limit ?? 50;
  const now = deps.now ?? (() => Date.now());
  return async () => {
    const startedAt = now();
    let store: ScheduledRunsStore | null;
    let launcher: ScheduledRunLauncher | null;
    try {
      store = await deps.resolveStore();
      launcher = await deps.resolveLauncher();
    } catch (err) {
      log.warn({ err, op: "scheduled-runs.resolve_failed" }, "resolve failed");
      return;
    }
    if (!store || !launcher) return;

    const { Cron } = await import(/* @vite-ignore */ "croner").catch((err) => {
      log.warn({ err, op: "scheduled-runs.croner_missing" }, "croner unavailable");
      return { Cron: null };
    });
    if (!Cron) return;
    const compute = (cron: string, tz: string, fromMs: number) =>
      computeNextRunWith(Cron as CronCtor, cron, tz, fromMs);

    let claimed: ClaimedSchedule[];
    try {
      claimed = await store.claimDue(startedAt, limit, compute);
    } catch (err) {
      log.error({ err, op: "scheduled-runs.claim_failed" }, "claimDue failed");
      return;
    }

    let ok = 0;
    let failed = 0;
    for (const schedule of claimed) {
      const ranAtMs = now();
      try {
        const { sessionId } = await launcher.launch(schedule);
        await store.recordRun(schedule.id, { status: "ok", sessionId, ranAtMs });
        ok += 1;
      } catch (err) {
        failed += 1;
        const message = err instanceof Error ? err.message : String(err);
        log.warn(
          { err, schedule_id: schedule.id, agent_id: schedule.agentId, op: "scheduled-runs.fire_failed" },
          "schedule fire failed",
        );
        // Best-effort — recording the failure must not itself abort the batch.
        try {
          await store.recordRun(schedule.id, { status: "error", error: message, ranAtMs });
        } catch (recordErr) {
          log.warn(
            { err: recordErr, schedule_id: schedule.id, op: "scheduled-runs.record_failed" },
            "recordRun failed",
          );
        }
      }
    }

    if (claimed.length > 0) {
      log.info(
        { op: "scheduled-runs.tick", claimed: claimed.length, ok, failed, dur_ms: now() - startedAt },
        "scheduled-agent-runs tick complete",
      );
    }
  };
}
