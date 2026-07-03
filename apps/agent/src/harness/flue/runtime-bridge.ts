/**
 * Runtime bridge — configures `@flue/runtime`'s application-level runtime so
 * `dispatch`-adjacent APIs stop throwing "runtime was configured" and a Flue
 * agent can actually run a turn.
 *
 * Background: Flue's public `dispatch()` checks a module-level singleton
 * (`configureFlueRuntime(cfg)`) before doing anything. Normally that singleton
 * is populated by the `@flue/cli`-generated server entry for a project built
 * with `--target node` or `--target cloudflare` — there is no public,
 * CLI-independent "just configure a runtime" API as of `1.0.0-beta.8` (the
 * assembly helpers below live under the explicitly-unstable `@flue/runtime/internal`
 * subpath, which the package's own generated entry imports from "because the
 * generated entry imports it from a stable bare specifier" — see that
 * package's own JSDoc on `configureFlueRuntime`).
 *
 * OMA's agent worker deploys to Cloudflare Workers, not plain Node — so the
 * Node target's own `sqlite()` persistence adapter (`@flue/runtime/node`) is
 * unusable here: it imports `node:sqlite`, which doesn't exist in Workers.
 * The Cloudflare target's `createCloudflareAgentRuntime` is built for
 * projects whose Durable Object class extends Cloudflare's own "agents" SDK
 * (`agents` npm package) — OMA's `SessionDO` does not, and retrofitting it to
 * do so purely to satisfy Flue's Cloudflare target is a much bigger, riskier
 * change than driving one Flue turn.
 *
 * So this module hand-assembles a minimal `NodeRuntime` (the "node" target's
 * runtime shape is storage-backend agnostic — nothing in it requires
 * `node:sqlite`, only the *default* `sqlite()` adapter does) backed by
 * Workers-safe, single-process, in-memory stores:
 *   - `agents`: a mutable per-turn registry (see {@link runFlueAgentTurn}).
 *   - `submissions`: {@link InMemoryAgentSubmissionStore} — the one store
 *     `@flue/runtime` doesn't ship an in-memory implementation of.
 *   - `runStore` / `attachmentStore` / `conversationStreamStore`: the
 *     package's own exported in-memory classes. `attachmentStore` and
 *     `conversationStreamStore` are NOT optional decoration here — the same
 *     instances are also handed to `createNodeAgentCoordinator`, because a
 *     direct-admission submission (what {@link runFlueAgentTurn} uses) only
 *     ever settles by writing a canonical `submission_settled` conversation
 *     record (`settleDirectSubmission` bails out with `false`, and the
 *     admission's result promise never resolves, when no conversation
 *     writer is configured). Every canonical record ever written to them
 *     stays in memory for the isolate's lifetime — see the trade-off note
 *     below.
 *   - `eventStreamStore`: {@link InMemoryEventStreamStore} — trivial, and
 *     never actually exercised by {@link runFlueAgentTurn} (it drives a turn
 *     via the coordinator's direct-admission path, not the HTTP DS-stream
 *     routes), but the `NodeRuntime` type requires the field.
 *
 * None of this durability is load-bearing for OMA *across restarts*: a Flue
 * turn here is a single in-process request/response, OMA's own session/
 * event-log stores are the durable record, and OMA's harness retry model
 * (not Flue's lease/reconciliation machinery) handles a mid-turn worker
 * restart. The in-memory stores exist to satisfy `@flue/runtime`'s internal
 * `AgentSubmissionStore` contract and (per above) the direct-submission
 * settlement path, so its (otherwise unmodified) coordinator and claim-loop
 * machinery can drive the turn. Trade-off: `conversationStreamStore` /
 * `attachmentStore` grow for as long as the isolate lives (nothing prunes
 * settled turns' canonical records) — acceptable for now given Workers
 * isolates are recycled periodically and per-turn records are small; a
 * follow-up can add pruning if this proves to matter in practice.
 */

import {
  configureFlueRuntime,
  createFlueContext,
  createNodeAgentCoordinator,
  createNodeDispatchQueue,
  resolveModel,
  InMemoryAttachmentStore,
  InMemoryConversationStreamStore,
  InMemoryRunStore,
} from "@flue/runtime/internal";
import type {
  AgentRecord,
  AgentSubmission,
  AgentSubmissionStore,
  CreateAgentContextFn,
  DirectAgentSubmissionInput,
  DispatchInput,
  EventStreamStore,
  NodeRuntime,
  SubmissionAttemptRef,
  SubmissionDurability,
  SubmissionSettlementObligation,
} from "@flue/runtime/internal";
import type { AgentDefinition } from "@flue/runtime";

const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;

// Not re-exported from `@flue/runtime/internal` (only present on the
// submodule the subpath re-exports from), so declared locally — structurally
// identical to `@flue/runtime`'s own (unexported) types of the same name.
interface SubmissionClaimRef extends SubmissionAttemptRef {
  readonly ownerId: string;
  readonly leaseExpiresAt: number;
}
interface AgentAttemptMarker {
  readonly submissionId: string;
  readonly attemptId: string;
  readonly createdAt: number;
}

/** Live agent registry backing `NodeRuntime.agents`. Mutated per-turn — see {@link runFlueAgentTurn}. */
const agents: AgentRecord[] = [];

let runtime: NodeRuntime | null = null;

/**
 * Build (once per isolate) and register the `NodeRuntime` singleton. Safe to
 * call repeatedly — the actual `configureFlueRuntime` call only happens once.
 */
function ensureFlueRuntimeConfigured(): NodeRuntime {
  if (runtime) return runtime;

  const submissions = new InMemoryAgentSubmissionStore();

  const createContext: CreateAgentContextFn = (options) =>
    createFlueContext({
      id: options.id,
      agentName: options.agentName,
      dispatchId: options.dispatchId,
      req: options.request,
      initialEventIndex: options.initialEventIndex,
      env: {},
      // Every agent FlueHarness builds sets `sandbox` explicitly (see
      // flue-loop.ts), so `resolveSessionEnv` never falls back to
      // `createDefaultEnv()`. It exists solely to satisfy the type.
      createDefaultEnv: async () => {
        throw new Error(
          "[flue] createDefaultEnv() was invoked — every FlueHarness-built agent must supply its own sandbox.",
        );
      },
      agentConfig: { resolveModel },
    });

  const conversationStreamStore = new InMemoryConversationStreamStore();
  const attachmentStore = new InMemoryAttachmentStore();

  const coordinator = createNodeAgentCoordinator({
    submissions,
    agents,
    createContext,
    conversationStreamStore,
    attachmentStore,
  });

  const built: NodeRuntime = {
    target: "node",
    agents,
    workflows: [],
    dispatchQueue: createNodeDispatchQueue(coordinator),
    admitWorkflow: async () => {
      throw new Error("[flue] Workflows are not supported by FlueHarness.");
    },
    createWorkflowContext: () => {
      throw new Error("[flue] Workflows are not supported by FlueHarness.");
    },
    createAgentAdmission: (agentName, instanceId) => coordinator.createAdmission(agentName, instanceId),
    abortAgentInstance: (agentName, instanceId) => coordinator.abortInstance(agentName, instanceId),
    runStore: new InMemoryRunStore(),
    eventStreamStore: new InMemoryEventStreamStore(),
    conversationStreamStore,
    attachmentStore,
  };

  configureFlueRuntime(built);
  runtime = built;
  return built;
}

/**
 * Drive one turn of `agent` for `instanceId` with `message`, and resolve when
 * it fully settles (or reject on failure/abort).
 *
 * Registers `agent` under a fresh, instance-scoped name for the duration of
 * the call (never a shared/stable slot) so two turns from different sessions
 * can never race each other's agent definition even if they happen to
 * overlap within the same isolate.
 *
 * Streaming events (`text_delta`, `tool_start`, …) are NOT returned here —
 * the caller already subscribes to them via the public `observe()` (scoped
 * by `event.instanceId`), same as before this bridge existed.
 */
export async function runFlueAgentTurn(opts: {
  agent: AgentDefinition;
  instanceId: string;
  message: string;
}): Promise<unknown> {
  const rt = ensureFlueRuntimeConfigured();
  const agentName = `oma-turn-${opts.instanceId}-${crypto.randomUUID()}`;
  agents.push({ name: agentName, definition: opts.agent });
  try {
    const admit = rt.createAgentAdmission(agentName, opts.instanceId);
    const receipt = await admit({ message: opts.message });
    return receipt.result;
  } finally {
    const idx = agents.findIndex((record) => record.name === agentName);
    if (idx !== -1) agents.splice(idx, 1);
  }
}

/**
 * Minimal in-memory `EventStreamStore`. Required to satisfy `NodeRuntime`'s
 * type but never exercised by {@link runFlueAgentTurn}: that path drives a
 * turn through the coordinator's direct-admission API, not the DS-protocol
 * HTTP routes (`handleStreamRead` et al.) this store backs.
 */
class InMemoryEventStreamStore implements EventStreamStore {
  #streams = new Map<string, { events: unknown[]; closed: boolean; listeners: Set<() => void> }>();

  #stream(path: string) {
    let s = this.#streams.get(path);
    if (!s) {
      s = { events: [], closed: false, listeners: new Set() };
      this.#streams.set(path, s);
    }
    return s;
  }

  async createStream(path: string): Promise<void> {
    this.#stream(path);
  }

  async appendEvent(path: string, event: unknown): Promise<string> {
    const s = this.#stream(path);
    s.events.push(event);
    const offset = String(s.events.length - 1);
    for (const listener of s.listeners) listener();
    return offset;
  }

  async appendEventOnce(path: string, _key: string, event: unknown): Promise<string> {
    return this.appendEvent(path, event);
  }

  async readEvents(path: string, opts?: { offset?: string; limit?: number }) {
    const s = this.#stream(path);
    const start = opts?.offset && opts.offset !== "-1" ? Number(opts.offset) + 1 : 0;
    const limit = opts?.limit ?? s.events.length;
    const slice = s.events.slice(start, start + limit).map((data, i) => ({ data, offset: String(start + i) }));
    const nextOffset = slice.length > 0 ? slice[slice.length - 1]!.offset : String(Math.max(start - 1, -1));
    return {
      events: slice,
      nextOffset,
      upToDate: start + slice.length >= s.events.length,
      closed: s.closed,
    };
  }

  async closeStream(path: string): Promise<void> {
    this.#stream(path).closed = true;
  }

  async getStreamMeta(path: string) {
    const s = this.#streams.get(path);
    if (!s) return null;
    return { nextOffset: s.events.length > 0 ? String(s.events.length - 1) : "-1", closed: s.closed };
  }

  subscribe(path: string, listener: () => void): () => void {
    const s = this.#stream(path);
    s.listeners.add(listener);
    return () => s.listeners.delete(listener);
  }
}

/**
 * Minimal in-memory `AgentSubmissionStore` — Workers-safe (no `node:sqlite`,
 * no Durable Object SQLite requirement), single-process, non-durable.
 *
 * `@flue/runtime` ships no in-memory implementation of this contract (only
 * a SQL-backed one shared by the Node and Cloudflare adapters), so this is
 * a from-scratch implementation of the documented contract in
 * `@flue/runtime/internal`'s `AgentSubmissionStore` JSDoc. It intentionally
 * does not implement true cross-restart recovery (there is nothing to
 * recover from an in-memory Map on restart) — see the module doc comment for
 * why that's an acceptable trade-off here.
 */
class InMemoryAgentSubmissionStore implements AgentSubmissionStore {
  #bySubmissionId = new Map<string, AgentSubmission>();
  #byDispatchId = new Map<string, string>();
  #settlements = new Map<string, SubmissionSettlementObligation>();
  #attemptMarkers = new Map<string, AgentAttemptMarker>();
  #sequence = 0;

  #sessionKeyOf(agent: string, id: string): string {
    return `${agent}::${id}`;
  }

  #isUnsettled(s: AgentSubmission): boolean {
    return s.status === "queued" || s.status === "running" || s.status === "terminalizing";
  }

  #sorted(): AgentSubmission[] {
    return [...this.#bySubmissionId.values()].sort((a, b) => a.sequence - b.sequence);
  }

  async getSubmission(submissionId: string): Promise<AgentSubmission | null> {
    return this.#bySubmissionId.get(submissionId) ?? null;
  }

  async hasUnsettledSubmissions(): Promise<boolean> {
    for (const s of this.#bySubmissionId.values()) if (this.#isUnsettled(s)) return true;
    return false;
  }

  async listRunnableSubmissions(): Promise<AgentSubmission[]> {
    const headBySession = new Map<string, AgentSubmission>();
    for (const s of this.#sorted()) {
      if (s.status === "settled") continue;
      if (!headBySession.has(s.sessionKey)) headBySession.set(s.sessionKey, s);
    }
    return this.#sorted().filter((s) => s.status === "queued" && headBySession.get(s.sessionKey) === s);
  }

  async listUnreadySubmissions(): Promise<AgentSubmission[]> {
    return this.#sorted().filter((s) => s.status === "queued" && s.canonicalReadyAt === null);
  }

  async listRunningSubmissions(): Promise<AgentSubmission[]> {
    return this.#sorted().filter((s) => s.status === "running");
  }

  async listPendingSubmissionSettlements(): Promise<SubmissionSettlementObligation[]> {
    return [...this.#settlements.values()];
  }

  async replaceSubmissionAttempt(
    attempt: SubmissionAttemptRef,
    nextAttemptId: string,
    lease?: { ownerId: string; leaseExpiresAt: number },
  ): Promise<AgentSubmission | null> {
    const s = this.#bySubmissionId.get(attempt.submissionId);
    if (!s || s.status !== "running" || s.attemptId !== attempt.attemptId) return null;
    const updated: AgentSubmission = {
      ...s,
      attemptId: nextAttemptId,
      attemptCount: s.attemptCount + 1,
      recoveryRequestedAt: undefined,
      ownerId: lease?.ownerId ?? s.ownerId,
      leaseExpiresAt: lease?.leaseExpiresAt ?? s.leaseExpiresAt,
    };
    this.#bySubmissionId.set(s.submissionId, updated);
    return updated;
  }

  async admitDispatch(input: DispatchInput) {
    const existingId = this.#byDispatchId.get(input.dispatchId);
    if (existingId) {
      const existing = this.#bySubmissionId.get(existingId);
      if (existing) return { kind: "submission" as const, submission: existing };
    }
    const submissionId = crypto.randomUUID();
    const submission: AgentSubmission = {
      sequence: this.#sequence++,
      submissionId,
      sessionKey: this.#sessionKeyOf(input.agent, input.id),
      kind: "dispatch",
      input: { kind: "dispatch", submissionId, ...input },
      status: "queued",
      acceptedAt: Date.now(),
      canonicalReadyAt: null,
      attemptCount: 0,
      maxRetry: DEFAULT_MAX_ATTEMPTS,
      timeoutAt: 0,
      leaseExpiresAt: 0,
    };
    this.#bySubmissionId.set(submissionId, submission);
    this.#byDispatchId.set(input.dispatchId, submissionId);
    return { kind: "submission" as const, submission };
  }

  async admitDirect(input: DirectAgentSubmissionInput): Promise<AgentSubmission> {
    const existing = this.#bySubmissionId.get(input.submissionId);
    if (existing) return existing;
    const submission: AgentSubmission = {
      sequence: this.#sequence++,
      submissionId: input.submissionId,
      sessionKey: this.#sessionKeyOf(input.agent, input.id),
      kind: "direct",
      input,
      status: "queued",
      acceptedAt: Date.now(),
      canonicalReadyAt: null,
      attemptCount: 0,
      maxRetry: DEFAULT_MAX_ATTEMPTS,
      timeoutAt: 0,
      leaseExpiresAt: 0,
    };
    this.#bySubmissionId.set(submission.submissionId, submission);
    return submission;
  }

  async markSubmissionCanonicalReady(submissionId: string): Promise<AgentSubmission | null> {
    const s = this.#bySubmissionId.get(submissionId);
    if (!s || s.status !== "queued") return null;
    const updated = { ...s, canonicalReadyAt: Date.now() };
    this.#bySubmissionId.set(submissionId, updated);
    return updated;
  }

  async claimSubmission(claim: SubmissionClaimRef): Promise<AgentSubmission | null> {
    const s = this.#bySubmissionId.get(claim.submissionId);
    if (!s || s.status !== "queued") return null;
    const runnable = await this.listRunnableSubmissions();
    if (!runnable.some((r) => r.submissionId === s.submissionId)) return null;
    const now = Date.now();
    const updated: AgentSubmission = {
      ...s,
      status: "running",
      attemptId: claim.attemptId,
      ownerId: claim.ownerId,
      leaseExpiresAt: claim.leaseExpiresAt,
      startedAt: s.startedAt ?? now,
      attemptCount: s.attemptCount + 1,
      timeoutAt: s.timeoutAt || now + DEFAULT_TIMEOUT_MS,
    };
    this.#bySubmissionId.set(s.submissionId, updated);
    return updated;
  }

  async markSubmissionInputApplied(
    attempt: SubmissionAttemptRef,
    durability?: SubmissionDurability,
  ): Promise<boolean> {
    const s = this.#bySubmissionId.get(attempt.submissionId);
    if (!s || s.status !== "running" || s.attemptId !== attempt.attemptId) return false;
    this.#bySubmissionId.set(s.submissionId, {
      ...s,
      inputAppliedAt: Date.now(),
      maxRetry: durability?.maxRetry ?? s.maxRetry,
      timeoutAt: durability?.timeoutAt ?? s.timeoutAt,
    });
    return true;
  }

  async requestSubmissionRecovery(attempt: SubmissionAttemptRef): Promise<boolean> {
    const s = this.#bySubmissionId.get(attempt.submissionId);
    if (!s || s.status !== "running" || s.attemptId !== attempt.attemptId) return false;
    this.#bySubmissionId.set(s.submissionId, { ...s, recoveryRequestedAt: Date.now() });
    return true;
  }

  async requestSessionAbort(sessionKey: string): Promise<string[]> {
    const affected: string[] = [];
    for (const s of this.#bySubmissionId.values()) {
      if (s.sessionKey !== sessionKey) continue;
      if (s.status !== "queued" && s.status !== "running") continue;
      affected.push(s.submissionId);
      if (s.abortRequestedAt === undefined) {
        this.#bySubmissionId.set(s.submissionId, { ...s, abortRequestedAt: Date.now() });
      }
    }
    return affected;
  }

  async requeueSubmissionBeforeInputApplied(attempt: SubmissionAttemptRef): Promise<boolean> {
    const s = this.#bySubmissionId.get(attempt.submissionId);
    if (!s || s.status !== "running" || s.attemptId !== attempt.attemptId || s.inputAppliedAt !== undefined) {
      return false;
    }
    this.#bySubmissionId.set(s.submissionId, {
      ...s,
      status: "queued",
      attemptId: undefined,
      ownerId: undefined,
      leaseExpiresAt: 0,
    });
    return true;
  }

  async reserveSubmissionSettlement(
    attempt: SubmissionAttemptRef,
    settlement: { recordId: string; record: SubmissionSettlementObligation["record"] },
  ): Promise<SubmissionSettlementObligation | null> {
    const s = this.#bySubmissionId.get(attempt.submissionId);
    if (!s || s.status !== "running" || s.attemptId !== attempt.attemptId) return null;
    const existing = this.#settlements.get(s.submissionId);
    if (existing) return existing.recordId === settlement.recordId ? existing : null;
    const obligation: SubmissionSettlementObligation = {
      submissionId: s.submissionId,
      sessionKey: s.sessionKey,
      attemptId: attempt.attemptId,
      recordId: settlement.recordId,
      record: settlement.record,
    };
    this.#settlements.set(s.submissionId, obligation);
    this.#bySubmissionId.set(s.submissionId, { ...s, status: "terminalizing" });
    return obligation;
  }

  async finalizeSubmissionSettlement(attempt: SubmissionAttemptRef, recordId: string): Promise<boolean> {
    const s = this.#bySubmissionId.get(attempt.submissionId);
    if (!s || s.status !== "terminalizing" || s.attemptId !== attempt.attemptId) return false;
    const obligation = this.#settlements.get(s.submissionId);
    if (!obligation || obligation.recordId !== recordId) return false;
    this.#settlements.delete(s.submissionId);
    this.#bySubmissionId.set(s.submissionId, { ...s, status: "settled" });
    return true;
  }

  async completeSubmission(attempt: SubmissionAttemptRef): Promise<boolean> {
    const s = this.#bySubmissionId.get(attempt.submissionId);
    if (!s || s.status !== "running" || s.attemptId !== attempt.attemptId) return false;
    this.#bySubmissionId.set(s.submissionId, { ...s, status: "settled" });
    return true;
  }

  async failSubmission(attempt: SubmissionAttemptRef, error: unknown): Promise<boolean> {
    const s = this.#bySubmissionId.get(attempt.submissionId);
    if (!s || s.status !== "running" || s.attemptId !== attempt.attemptId) return false;
    this.#bySubmissionId.set(s.submissionId, {
      ...s,
      status: "settled",
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }

  async insertAttemptMarker(attempt: SubmissionAttemptRef): Promise<void> {
    const key = `${attempt.submissionId}:${attempt.attemptId}`;
    if (!this.#attemptMarkers.has(key)) {
      this.#attemptMarkers.set(key, { submissionId: attempt.submissionId, attemptId: attempt.attemptId, createdAt: Date.now() });
    }
  }

  async deleteAttemptMarker(attempt: SubmissionAttemptRef): Promise<void> {
    this.#attemptMarkers.delete(`${attempt.submissionId}:${attempt.attemptId}`);
  }

  async listAttemptMarkers(): Promise<AgentAttemptMarker[]> {
    return [...this.#attemptMarkers.values()];
  }

  async renewLeases(ownerId: string, submissionIds: string[]): Promise<void> {
    for (const id of submissionIds) {
      const s = this.#bySubmissionId.get(id);
      if (s && s.status === "running" && s.ownerId === ownerId) {
        this.#bySubmissionId.set(id, { ...s, leaseExpiresAt: Date.now() + 30_000 });
      }
    }
  }

  async listExpiredSubmissions(): Promise<AgentSubmission[]> {
    const now = Date.now();
    return this.#sorted().filter((s) => s.status === "running" && s.leaseExpiresAt > 0 && s.leaseExpiresAt < now);
  }
}
