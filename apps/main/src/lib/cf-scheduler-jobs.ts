// CF scheduler wiring — registers the CF cron handlers via the
// runtime-agnostic Scheduler interface. Each handler is the same one
// registered by Node in apps/main-node/src/lib/node-scheduler-jobs.ts.
//
// CF still owns the schedule itself (wrangler `triggers.crons`). The
// scheduled() entry below calls `dispatch(controller.cron)` to look up
// and invoke registered jobs whose cron expression matches.

import type { Env } from "@duyet/oma-shared";
import { log, logError, recordEvent, errFields } from "@duyet/oma-shared";
import { forEachShardServices, getCfServicesForTenant } from "@duyet/oma-services";
import { CfD1SqlClient } from "@duyet/oma-sql-client/adapters/cf-d1";
import { createCfScheduler, type CfScheduler } from "@duyet/oma-scheduler/cf";
import { memoryRetentionTick } from "@duyet/oma-scheduler/jobs/memory-retention";
import { webhookEventsRetentionTick } from "@duyet/oma-scheduler/jobs/webhook-events-retention";
import {
  scheduledAgentRunsTick,
  type ScheduledRunLauncher,
} from "@duyet/oma-scheduler/jobs/scheduled-agent-runs";
import { SqlClientScheduledRunsStore } from "@duyet/oma-scheduler/jobs/scheduled-agent-runs-store";
import {
  scheduledDeploymentRunsTick,
  type ScheduledDeploymentRunLauncher,
} from "@duyet/oma-scheduler/jobs/scheduled-deployment-runs";
import { SqlClientScheduledDeploymentRunsStore } from "@duyet/oma-scheduler/jobs/scheduled-deployment-runs-store";
import { withHealthchecks } from "@duyet/oma-shared";
import { tickEvalRuns } from "../eval-runner";
import { createInternalSession } from "../routes/internal";
import { launchDeploymentSession } from "./deployment-runs";
import { dreamRecoveryTick } from "../cron/dream-recovery";

// Cron expressions are env-overridable so ops can shift sweeps without a
// code deploy. Defaults match the pre-extract behaviour exactly.
function envCron(env: Env, key: string, fallback: string): string {
  const raw = (env as unknown as Record<string, string | undefined>)[key];
  return raw && raw.trim() ? raw : fallback;
}

export function buildCfScheduler(env: Env): CfScheduler {
  const scheduler = createCfScheduler();
  const tickCron = envCron(env, "EVAL_TICK_CRON", "* * * * *");
  const memoryCron = envCron(env, "MEMORY_RETENTION_CRON", "* * * * *");
  const webhookCron = envCron(env, "WEBHOOK_EVENTS_RETENTION_CRON", "* * * * *");
  const dreamsCron = envCron(env, "DREAM_RECOVERY_CRON", "* * * * *");

  scheduler.register({
    name: "eval-tick",
    cron: tickCron,
    handler: withHealthchecks(env, "eval-tick", () =>
      tickEvalRuns(env).then(
        (result) =>
          log(
            { op: "cron.tick_eval_runs", advanced: result.advanced, total: result.total },
            "tickEvalRuns ok",
          ),
        (err) => {
          logError({ op: "cron.tick_eval_runs", err }, "tickEvalRuns failed");
          recordEvent(env.ANALYTICS, {
            op: "cron.tick_eval_runs.failed",
            ...errFields(err),
          });
        },
      ),
    ),
  });

  scheduler.register({
    name: "memory-retention",
    cron: memoryCron,
    handler: withHealthchecks(env, "memory-retention", memoryRetentionTick({
      forEachShard: (fn) => forEachShardServices(env, (s, name) => fn(s, name)),
    })),
  });

  scheduler.register({
    name: "webhook-events-retention",
    cron: webhookCron,
    handler: withHealthchecks(env, "webhook-events-retention", webhookEventsRetentionTick({
      resolveIntegrationsDb: () =>
        env.INTEGRATIONS_DB ? new CfD1SqlClient(env.INTEGRATIONS_DB) : null,
    })),
  });

  scheduler.register({
    name: "dream-recovery",
    cron: dreamsCron,
    handler: withHealthchecks(env, "dream-recovery", () => dreamRecoveryTick(env)),
  });

  // Scheduled agent runs (issue #77) — fires user-defined agent schedules.
  // agent_schedules lives in the single shared control-plane DB (MAIN_DB),
  // so the store reads from there directly; the launcher resolves each
  // schedule's tenant shard to actually create the session. Only registered
  // when MAIN_DB is bound.
  //
  // TODO(node): apps/main-node has no agent_schedules table yet
  // (packages/db-schema has no schedules dialect) and no schedules CRUD
  // route, so there is nothing to fire on the Node deployment. When those
  // land, register the same scheduledAgentRunsTick in node-scheduler-jobs.ts
  // with a SqlClientScheduledRunsStore over the Node control-plane DB and a
  // launcher over the Node session-create path.
  if (env.MAIN_DB) {
    const scheduledRunsCron = envCron(env, "SCHEDULED_AGENT_RUNS_CRON", "* * * * *");
    const launcher: ScheduledRunLauncher = {
      // max_sessions concurrency cap (issue #165): count this schedule's
      // still in-flight sessions in ITS tenant shard (sessions live per-shard,
      // agent_schedules lives in the shared MAIN_DB — see AGENTS.md "Sandbox
      // Provider" / services layering) before the tick decides to launch.
      async countActive(schedule) {
        const services = await getCfServicesForTenant(env, schedule.tenantId);
        return services.sessions.countActiveByScheduleId({
          tenantId: schedule.tenantId,
          scheduleId: schedule.id,
        });
      },
      async launch(schedule) {
        if (!schedule.environmentId) {
          throw new Error("schedule has no environment_id");
        }
        if (!schedule.userId) {
          throw new Error("schedule has no user_id");
        }
        const services = await getCfServicesForTenant(env, schedule.tenantId);
        const result = await createInternalSession(env, services, {
          action: "create",
          userId: schedule.userId,
          agentId: schedule.agentId,
          environmentId: schedule.environmentId,
          metadata: { scheduled_run: { schedule_id: schedule.id } },
          initialEvent: {
            type: "user.message",
            content: [{ type: "text", text: schedule.prompt }],
          },
        });
        if (!result.ok) {
          throw new Error(`session create failed (${result.status}): ${result.error}`);
        }
        return { sessionId: result.sessionId };
      },
    };
    scheduler.register({
      name: "scheduled-agent-runs",
      cron: scheduledRunsCron,
      handler: withHealthchecks(
        env,
        "scheduled-agent-runs",
        scheduledAgentRunsTick({
          resolveStore: async () =>
            new SqlClientScheduledRunsStore(new CfD1SqlClient(env.MAIN_DB)),
          resolveLauncher: async () => launcher,
        }),
      ),
    });

    // Scheduled deployment runs — fires deployments whose trigger is
    // {"type":"schedule"}. Same shared MAIN_DB + tenant-shard launcher pattern
    // as scheduled-agent-runs, but carries the deployment's vaults / memory
    // stores / pinned agent version into each fired session.
    const deploymentRunsCron = envCron(env, "SCHEDULED_DEPLOYMENT_RUNS_CRON", "* * * * *");
    const deploymentLauncher: ScheduledDeploymentRunLauncher = {
      async launch(deployment) {
        return launchDeploymentSession(env, deployment);
      },
    };
    scheduler.register({
      name: "scheduled-deployment-runs",
      cron: deploymentRunsCron,
      handler: withHealthchecks(
        env,
        "scheduled-deployment-runs",
        scheduledDeploymentRunsTick({
          resolveStore: async () =>
            new SqlClientScheduledDeploymentRunsStore(new CfD1SqlClient(env.MAIN_DB)),
          resolveLauncher: async () => deploymentLauncher,
        }),
      ),
    });
  }

  return scheduler;
}
