// CF scheduler wiring — registers the CF cron handlers via the
// runtime-agnostic Scheduler interface. Each handler is the same one
// registered by Node in apps/main-node/src/lib/node-scheduler-jobs.ts.
//
// CF still owns the schedule itself (wrangler `triggers.crons`). The
// scheduled() entry below calls `dispatch(controller.cron)` to look up
// and invoke registered jobs whose cron expression matches.

import type { Env } from "@duyet/oma-shared";
import { log, logError, recordEvent, errFields } from "@duyet/oma-shared";
import { forEachShardServices } from "@duyet/oma-services";
import { CfD1SqlClient } from "@duyet/oma-sql-client/adapters/cf-d1";
import { createCfScheduler, type CfScheduler } from "@duyet/oma-scheduler/cf";
import { memoryRetentionTick } from "@duyet/oma-scheduler/jobs/memory-retention";
import { webhookEventsRetentionTick } from "@duyet/oma-scheduler/jobs/webhook-events-retention";
import { withHealthchecks } from "@duyet/oma-shared";
import { tickEvalRuns } from "../eval-runner";
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

  return scheduler;
}
