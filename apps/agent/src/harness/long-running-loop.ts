import type { HarnessContext, HarnessRuntime } from "./interface";
import { DefaultHarness } from "./default-loop";

/**
 * Long-running coding-agent harness.
 *
 * Motivation: multi-hour refactors / CI-fix loops report progress only via
 * free-text `agent.message` events. A manager UI (or a human babysitting a
 * session) needs a STRUCTURED "what step are we on / blocked on what" signal.
 *
 * This harness is a thin wrapper over `DefaultHarness` — it inherits the whole
 * model loop, compaction, context derivation, and tool-event emission
 * unchanged. Its only job is to shape and pace the `agent.status` heartbeat:
 *
 *   1. Emits a status report immediately on every `run()` so a turn always
 *      surfaces at least one report (covers zero-model-turn runs and seeds the
 *      recovery counter).
 *   2. Enriches DefaultHarness's per-model-turn `reportStatus` calls with a
 *      monotonic step index + the agent's `metadata.total_steps_estimate`.
 *   3. Fires a wall-clock heartbeat every `metadata.status_report_interval_ms`
 *      (default 60s) so a single long-running model/tool step still reports
 *      progress even when no new model turn fires.
 *   4. On turn end, if any tool calls are awaiting user confirmation, emits a
 *      `state: "blocked"` report with a `blocked_on` explanation.
 *
 * Prompt-cache safety: everything here flows through `runtime.reportStatus`,
 * which writes `agent.status` events. Those are NOT projected into model
 * context (eventsToMessages / eventsToMessagesAsync skip them, same as span.*),
 * so no amount of status reporting can perturb `deriveModelContext`'s
 * byte-deterministic output or invalidate Anthropic's prompt cache. Because
 * status events contribute zero tokens to the derived messages, they also
 * cannot force early compaction — `shouldCompact` estimates from the derived
 * projection, which excludes them.
 *
 * Crash recovery: the step counter is seeded from the count of `agent.status`
 * events already in the durable log, so numbering stays monotonic across a
 * crash-and-resume (a fresh `run()` continues above the prior run's reports
 * instead of restarting at 1 — no duplicate/missing step numbers).
 */
export class LongRunningHarness extends DefaultHarness {
  async run(ctx: HarnessContext): Promise<void> {
    const meta = (ctx.agent.metadata ?? {}) as Record<string, unknown>;
    const totalEstimate =
      typeof meta.total_steps_estimate === "number" && meta.total_steps_estimate > 0
        ? (meta.total_steps_estimate as number)
        : undefined;
    const intervalMs =
      typeof meta.status_report_interval_ms === "number" && meta.status_report_interval_ms > 0
        ? (meta.status_report_interval_ms as number)
        : 60_000;

    // Monotonic base across crash recovery: continue numbering above any
    // agent.status events already durably in the log (a prior, crashed run's
    // reports). A fresh in-memory counter would restart at 1 and produce
    // duplicate step numbers after recovery.
    let reportSeq = ctx.runtime.history
      .getEvents()
      .filter((e) => e.type === "agent.status").length;

    const startedAt = Date.now();
    const inner = ctx.runtime.reportStatus?.bind(ctx.runtime);

    const emit = (s: {
      state: "working" | "blocked" | "waiting";
      summary: string;
      total_steps?: number;
      detail?: string;
      blocked_on?: string;
    }): void => {
      reportSeq += 1;
      inner?.({
        state: s.state,
        summary: s.summary,
        // step is the monotonic report index — "what step are we on" — not the
        // model-turn number, so it survives crash recovery unbroken.
        step: reportSeq,
        total_steps: s.total_steps ?? totalEstimate,
        ...(s.detail ? { detail: s.detail } : {}),
        ...(s.blocked_on ? { blocked_on: s.blocked_on } : {}),
      });
    };

    // Wrap the runtime so DefaultHarness's per-model-turn reportStatus calls
    // (fired in experimental_onStepStart) get enriched + monotonically
    // numbered. `Object.create` keeps the original runtime as the prototype so
    // every other member (own OR prototype method — the CF path builds a plain
    // object, the Node path a class instance) resolves through unchanged; we
    // only shadow reportStatus.
    const wrappedRuntime: HarnessRuntime = Object.assign(
      Object.create(ctx.runtime) as HarnessRuntime,
      { reportStatus: (s: Parameters<NonNullable<HarnessRuntime["reportStatus"]>>[0]) => emit(s) },
    );

    // (1) Immediate report — a run always emits at least one status event.
    emit({
      state: "working",
      summary: reportSeq > 0 ? "Resuming task" : "Starting task",
    });

    // (3) Wall-clock heartbeat for long single steps with no new model turns.
    const timer = setInterval(() => {
      const elapsedS = Math.round((Date.now() - startedAt) / 1000);
      emit({ state: "working", summary: `Still working (${elapsedS}s elapsed)` });
    }, intervalMs);

    try {
      await super.run({ ...ctx, runtime: wrappedRuntime });
    } finally {
      clearInterval(timer);
    }

    // (4) Blocked signal — the turn ended with tool calls awaiting user
    // confirmation. DefaultHarness populates pendingConfirmations on ctx's
    // (unwrapped) runtime.
    const pending = ctx.runtime.pendingConfirmations?.length ?? 0;
    if (pending > 0) {
      emit({
        state: "blocked",
        summary: "Waiting for tool confirmation",
        blocked_on: `${pending} tool call${pending === 1 ? "" : "s"} awaiting confirmation`,
      });
    }
  }
}
