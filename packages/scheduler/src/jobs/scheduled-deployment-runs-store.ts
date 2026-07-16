// SqlClient-backed store for scheduled deployment runs.
//
// deployments lives in the single shared control-plane DB (MAIN_DB on CF).
// This adapter is dialect-neutral — it only uses the SqlClient port. Mirrors
// scheduled-agent-runs-store.ts; the CAS claim is identical.
//
// next_run_at is stored as an ISO-8601 TEXT string (matching created_at):
// ISO-8601 sorts lexicographically, so `next_run_at <= ?` string comparison
// is a correct time comparison.
//
// Only schedule-triggered rows have a non-null next_run_at, so filtering on
// `next_run_at <= ?` already excludes manual/webhook deployments.

import type { SqlClient } from "@duyet/oma-sql-client";
import { parseStringArray } from "@duyet/oma-shared";
import type {
  ClaimedDeployment,
  RecordDeploymentRunInput,
  ScheduledDeploymentRunsStore,
} from "./scheduled-deployment-runs";

interface DueRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  agent_version: number | null;
  environment_id: string | null;
  user_id: string | null;
  vault_ids: string | null;
  memory_store_ids: string | null;
  initial_message: string;
  trigger: string | null;
  next_run_at: string;
}

// The schedule cadence lives INSIDE the trigger JSON (there is no `timezone`
// column on `deployments` — see apps/main/migrations/0023_deployments.sql).
// Parse both cron + timezone out of it here.
function scheduleFromTrigger(raw: string | null): { cron: string; timezone: string } | null {
  if (!raw) return null;
  try {
    const t = JSON.parse(raw) as { type?: string; cron_expression?: string; timezone?: string };
    if (t?.type === "schedule" && typeof t.cron_expression === "string") {
      return {
        cron: t.cron_expression,
        timezone: typeof t.timezone === "string" && t.timezone ? t.timezone : "UTC",
      };
    }
    return null;
  } catch {
    return null;
  }
}

export class SqlClientScheduledDeploymentRunsStore implements ScheduledDeploymentRunsStore {
  constructor(private readonly db: SqlClient) {}

  async claimDue(
    nowMs: number,
    limit: number,
    computeNextRun: (cron: string, timezone: string, fromMs: number) => number | null,
  ): Promise<ClaimedDeployment[]> {
    const nowIso = new Date(nowMs).toISOString();

    const candidates = await this.db
      .prepare(
        `SELECT id, tenant_id, agent_id, agent_version, environment_id, user_id,
                vault_ids, memory_store_ids, initial_message, trigger, next_run_at
         FROM deployments
         WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
         ORDER BY next_run_at ASC
         LIMIT ?`,
      )
      .bind(nowIso, limit)
      .all<DueRow>();

    const rows = candidates.results ?? [];
    const claimed: ClaimedDeployment[] = [];

    for (const row of rows) {
      const sched = scheduleFromTrigger(row.trigger);
      const cron = sched?.cron ?? null;
      const timezone = sched?.timezone ?? "UTC";
      // A row with a non-null next_run_at but no schedule cron shouldn't exist,
      // but if it does, park it by nulling next_run_at (via the CAS below).
      const nextMs = cron ? computeNextRun(cron, timezone, nowMs) : null;
      const nextIso = nextMs != null ? new Date(nextMs).toISOString() : null;

      // Compare-and-set: only the tick whose old next_run_at still matches wins.
      const res = await this.db
        .prepare(
          `UPDATE deployments
           SET next_run_at = ?
           WHERE id = ? AND next_run_at = ? AND enabled = 1`,
        )
        .bind(nextIso, row.id, row.next_run_at)
        .run();

      if ((res.meta?.changes ?? 0) === 1 && cron) {
        claimed.push({
          id: row.id,
          tenantId: row.tenant_id,
          agentId: row.agent_id,
          agentVersion: row.agent_version,
          environmentId: row.environment_id,
          userId: row.user_id,
          vaultIds: parseStringArray(row.vault_ids),
          memoryStoreIds: parseStringArray(row.memory_store_ids),
          cron,
          timezone,
          initialMessage: row.initial_message,
        });
      }
    }

    return claimed;
  }

  async recordRun(id: string, input: RecordDeploymentRunInput): Promise<void> {
    const ranAtIso = new Date(input.ranAtMs).toISOString();
    await this.db
      .prepare(
        `UPDATE deployments
         SET last_run_at = ?, last_run_status = ?, last_run_error = ?, last_session_id = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(ranAtIso, input.status, input.error ?? null, input.sessionId ?? null, ranAtIso, id)
      .run();
  }
}
