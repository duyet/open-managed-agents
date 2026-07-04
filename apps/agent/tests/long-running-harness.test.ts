// Unit test for the long-running harness (`src/harness/long-running-loop.ts`).
//
// Drives LongRunningHarness.run() against a mocked language model (AI SDK
// MockLanguageModelV3 + simulateReadableStream) with a fake HarnessRuntime
// that captures broadcast events. Proves the three things the harness adds
// over DefaultHarness:
//   1. It emits structured `agent.status` heartbeats over a simulated run.
//   2. Reports carry `total_steps` from `metadata.total_steps_estimate`.
//   3. Step numbering stays monotonic across a crash-and-resume (seeded from
//      prior agent.status events in the log — no duplicate/missing reports).
//   4. A run ending with pending tool confirmations emits a `blocked` report
//      carrying `blocked_on`.

import { describe, it, expect } from "vitest";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { LongRunningHarness } from "../src/harness/long-running-loop";
import type { HarnessContext, HarnessRuntime } from "../src/harness/interface";
import type { SessionEvent } from "@duyet/oma-shared";

/** A minimal single-step assistant text turn: streamText sees text + a clean
 *  `stop` finish, so the run completes in one model turn with no tool calls. */
function singleTextStep(text: string) {
  const chunks: LanguageModelV3StreamPart[] = [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "0" },
    { type: "text-delta", id: "0", delta: text },
    { type: "text-end", id: "0" },
    {
      type: "finish",
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 2, text: 2, reasoning: 0 },
      },
    },
  ];
  return { stream: simulateReadableStream({ chunks, chunkDelayInMs: null, initialDelayInMs: null }) };
}

/** One-step model. doStream is a function so the ReadableStream is rebuilt on
 *  each call (retry-safe; a stream can only be consumed once). */
function mockModel(text: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    modelId: "mock-model",
    doStream: async () => singleTextStep(text),
  });
}

/** Fake runtime that records every broadcast event. `reportStatus` mirrors the
 *  real runtimes (session-do / node-harness-runtime): it just builds the
 *  agent.status event and routes through the same broadcast/append path. */
function makeRuntime(seed: SessionEvent[] = [], pendingConfirmations: string[] = []) {
  const events: SessionEvent[] = [...seed];
  const runtime: HarnessRuntime = {
    history: {
      getMessages: () => [],
      append: (e: SessionEvent) => {
        events.push(e);
      },
      getEvents: () => events,
    },
    // sandbox is unused for a no-tool run.
    sandbox: {} as HarnessRuntime["sandbox"],
    broadcast: (e: SessionEvent) => {
      events.push(e);
    },
    broadcastStreamStart: async () => {},
    broadcastChunk: async () => {},
    broadcastStreamEnd: async () => {},
    broadcastThinkingStart: async () => {},
    broadcastThinkingChunk: async () => {},
    broadcastThinkingEnd: async () => {},
    broadcastToolInputStart: async () => {},
    broadcastToolInputChunk: async () => {},
    broadcastToolInputEnd: async () => {},
    reportUsage: async () => {},
    reportStatus: (status) => {
      events.push({ type: "agent.status", ...status } as unknown as SessionEvent);
    },
    pendingConfirmations,
  };
  return { runtime, events };
}

function makeCtx(
  model: MockLanguageModelV3,
  runtime: HarnessRuntime,
  metadata: Record<string, unknown> = {},
): HarnessContext {
  return {
    agent: {
      name: "long-runner",
      model: "mock-model",
      system: "",
      metadata,
    },
    userMessage: { type: "user.message", content: [{ type: "text", text: "go" }] },
    tools: {},
    model: model as unknown as HarnessContext["model"],
    systemPrompt: "",
    env: { ANTHROPIC_API_KEY: "test" },
    runtime,
  } as unknown as HarnessContext;
}

const statusEvents = (events: SessionEvent[]) =>
  events.filter((e) => e.type === "agent.status") as Array<
    SessionEvent & {
      type: "agent.status";
      state: string;
      summary: string;
      step?: number;
      total_steps?: number;
      blocked_on?: string;
    }
  >;

describe("LongRunningHarness", () => {
  it("emits structured agent.status heartbeats over a simulated run", async () => {
    // Seed one user.message so deriveModelContext produces a non-empty prompt.
    const { runtime, events } = makeRuntime([
      { type: "user.message", content: [{ type: "text", text: "go" }] } as SessionEvent,
    ]);
    const harness = new LongRunningHarness();
    await harness.run(makeCtx(mockModel("Done."), runtime, { total_steps_estimate: 5 }));

    const statuses = statusEvents(events);
    // At least the immediate "starting" report + one per-model-turn report.
    expect(statuses.length).toBeGreaterThanOrEqual(2);
    // total_steps carries metadata.total_steps_estimate.
    expect(statuses.every((s) => s.total_steps === 5)).toBe(true);
    // Steps are strictly monotonic starting from 1.
    const steps = statuses.map((s) => s.step);
    expect(steps).toEqual([...steps].sort((a, b) => (a ?? 0) - (b ?? 0)));
    expect(new Set(steps).size).toBe(steps.length);
    expect(steps[0]).toBe(1);
  });

  it("continues step numbering monotonically across crash recovery", async () => {
    // Prior run left two agent.status events in the durable log.
    const prior: SessionEvent[] = [
      { type: "user.message", content: [{ type: "text", text: "go" }] } as SessionEvent,
      { type: "agent.status", state: "working", summary: "Starting task", step: 1 } as unknown as SessionEvent,
      { type: "agent.status", state: "working", summary: "Working on step 2", step: 2 } as unknown as SessionEvent,
    ];
    const { runtime, events } = makeRuntime(prior);
    const harness = new LongRunningHarness();
    await harness.run(makeCtx(mockModel("Resumed."), runtime, {}));

    // Only the reports minted by THIS run (appended after the seed).
    const newStatuses = statusEvents(events.slice(prior.length));
    expect(newStatuses.length).toBeGreaterThanOrEqual(1);
    // Every new report's step is above the 2 that already existed — no
    // duplicate/missing numbers after recovery.
    expect(newStatuses.every((s) => (s.step ?? 0) >= 3)).toBe(true);
    expect(newStatuses[0].step).toBe(3);
  });

  it("emits a blocked report with blocked_on when tool confirmations are pending", async () => {
    const { runtime, events } = makeRuntime(
      [{ type: "user.message", content: [{ type: "text", text: "go" }] } as SessionEvent],
      ["toolcall-awaiting-confirm"],
    );
    const harness = new LongRunningHarness();
    await harness.run(makeCtx(mockModel("Need approval."), runtime, {}));

    const blocked = statusEvents(events).filter((s) => s.state === "blocked");
    expect(blocked.length).toBe(1);
    expect(blocked[0].blocked_on).toContain("awaiting confirmation");
  });
});
