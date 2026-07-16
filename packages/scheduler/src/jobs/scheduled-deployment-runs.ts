// Scheduled deployment runs — the cron tick for deployments whose trigger is
// {"type":"schedule", ...}. Mirrors scheduled-agent-runs.ts (issue #77) but
// carries the richer deployment bundle (vault ids, memory stores, pinned
// agent version, initial message) into each fired session.
//
// Each per-minute cron tick:
//   1. Selects due deployments (enabled AND trigger.type=schedule AND
//      next_run_at <= now).
//   2. Claims each row idempotently — a compare-and-set that advances
//      next_run_at to the *next* cron occurrence in the same statement, so
//      overlapping ticks or Node replicas can't double-fire an occurrence.
//   3. Launches a session for the claimed deployment (the initial_message
//      injected as a user.message — no human turn), reusing the host's
//      session-creation path with the deployment's env / vaults / memory
//      stores / pinned version.
//   4. Records last_run status/error on the row.
//
// Fail-open per deployment: one bad row (bad cron, launch failure) is logged
// and skipped, never blocking the others.
//
// Cron parsing is shared with scheduled-agent-runs (computeNextRunWith), so
// both jobs advance next_run_at identically.

import { getLogger } from "@duyet/oma-observability";
import { computeNextRunWith, type CronCtor } from "./scheduled-agent-runs";

const log = getLogger("scheduler.scheduled-deployment-runs");

/** A deployment the tick has *claimed* and is responsible for firing once. */
export interface ClaimedDeployment {
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
}

export interface RecordDeploymentRunInput {
  status: "ok" | "error";
  error?: string | null;
  sessionId?: string | null;
  ranAtMs: number;
}

export interface ScheduledDeploymentRunsStore {
  /**
   * Atomically select-and-claim up to `limit` due deployments. The claim MUST
   * advance next_run_at to the next occurrence within the same compare-and-set
   * so a concurrent tick can't re-select the same row.
   */
  claimDue(
    nowMs: number,
    limit: number,
    computeNextRun: (cron: string, timezone: string, fromMs: number) => number | null,
  ): Promise<ClaimedDeployment[]>;

  /** Persist the outcome of a fired deployment (last_run_* columns). */
  recordRun(id: string, input: RecordDeploymentRunInput): Promise<void>;
}

export interface ScheduledDeploymentRunLauncher {
  /** Create a session for the deployment and inject `initialMessage` as a
   *  user.message. Returns the created session id. Throws on failure. */
  launch(deployment: ClaimedDeployment): Promise<{ sessionId: string }>;
}

export interface ScheduledDeploymentRunsTickDeps {
  resolveStore: () => Promise<ScheduledDeploymentRunsStore | null>;
  resolveLauncher: () => Promise<ScheduledDeploymentRunLauncher | null>;
  /** Cap deployments fired per tick. Default 50. */
  limit?: number;
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number;
}

export function scheduledDeploymentRunsTick(
  deps: ScheduledDeploymentRunsTickDeps,
): () => Promise<void> {
  const limit = deps.limit ?? 50;
  const now = deps.now ?? (() => Date.now());
  return async () => {
    const startedAt = now();
    let store: ScheduledDeploymentRunsStore | null;
    let launcher: ScheduledDeploymentRunLauncher | null;
    try {
      store = await deps.resolveStore();
      launcher = await deps.resolveLauncher();
    } catch (err) {
      log.warn({ err, op: "scheduled-deployment-runs.resolve_failed" }, "resolve failed");
      return;
    }
    if (!store || !launcher) return;

    const { Cron } = await import(/* @vite-ignore */ "croner").catch((err) => {
      log.warn({ err, op: "scheduled-deployment-runs.croner_missing" }, "croner unavailable");
      return { Cron: null };
    });
    if (!Cron) return;
    const compute = (cron: string, tz: string, fromMs: number) =>
      computeNextRunWith(Cron as CronCtor, cron, tz, fromMs);

    let claimed: ClaimedDeployment[];
    try {
      claimed = await store.claimDue(startedAt, limit, compute);
    } catch (err) {
      log.error({ err, op: "scheduled-deployment-runs.claim_failed" }, "claimDue failed");
      return;
    }

    let ok = 0;
    let failed = 0;
    for (const deployment of claimed) {
      const ranAtMs = now();
      try {
        const { sessionId } = await launcher.launch(deployment);
        await store.recordRun(deployment.id, { status: "ok", sessionId, ranAtMs });
        ok += 1;
      } catch (err) {
        failed += 1;
        const message = err instanceof Error ? err.message : String(err);
        log.warn(
          {
            err,
            deployment_id: deployment.id,
            agent_id: deployment.agentId,
            op: "scheduled-deployment-runs.fire_failed",
          },
          "deployment fire failed",
        );
        try {
          await store.recordRun(deployment.id, { status: "error", error: message, ranAtMs });
        } catch (recordErr) {
          log.warn(
            { err: recordErr, deployment_id: deployment.id, op: "scheduled-deployment-runs.record_failed" },
            "recordRun failed",
          );
        }
      }
    }

    if (claimed.length > 0) {
      log.info(
        { op: "scheduled-deployment-runs.tick", claimed: claimed.length, ok, failed, dur_ms: now() - startedAt },
        "scheduled-deployment-runs tick complete",
      );
    }
  };
}
