/**
 * FlueHarness — a `HarnessInterface` implementation that runs a Flue agent as
 * a managed OMA harness. Like {@link AcpProxyHarness}, it is a META-harness:
 * OMA does not drive its own `generateText` loop here. Instead it hands the
 * turn to the Flue runtime, which owns the model loop, tool execution, and its
 * own context management — so the compaction / context ports are no-ops.
 *
 * Per-turn flow:
 *   1. Adapt the OMA sandbox into a Flue `SessionEnv` (see
 *      `./flue/sandbox-bridge.ts`).
 *   2. Register the model provider from OMA's credentials (see
 *      `./flue/provider-bridge.ts`) and get back the `provider/model`
 *      specifier.
 *   3. Build a Flue agent with `defineAgent({ model, sandbox, instructions })`.
 *   4. Subscribe to Flue's event stream via `observe(...)`, scope events to
 *      this interaction, and translate them into OMA `SessionEvent`s (see
 *      `./flue/translate.ts`).
 *   5. Deliver the user message via `runFlueAgentTurn(...)` (see
 *      `./flue/runtime-bridge.ts`) and await the turn's settlement.
 *
 * ── End-to-end status ────────────────────────────────────────────────────
 * The two bridges (sandbox + provider), the event translator, and the
 * runtime bridge are unit-tested. `runtime-bridge.ts` lazily configures
 * Flue's app runtime (`configureFlueRuntime(...)`, the wiring the Flue CLI
 * generates for a standalone deployment) with Workers-safe in-memory stores,
 * so `run()` below drives a real end-to-end turn.
 */

import { defineAgent, createSandboxSessionEnv, registerProvider, observe } from "@flue/runtime";
import type { SandboxFactory, FlueEvent } from "@flue/runtime";
import type { HarnessInterface, HarnessContext, HarnessRuntime } from "./interface";
import type { SessionEvent, UserMessageEvent } from "@open-managed-agents/shared";
import { generateEventId, log, logError } from "@open-managed-agents/shared";
import { createFlueSandboxApi } from "./flue/sandbox-bridge";
import { buildFlueProvider, type FlueProviderApi } from "./flue/provider-bridge";
import { FlueEventTranslator } from "./flue/translate";
import { runFlueAgentTurn } from "./flue/runtime-bridge";

/**
 * Default working directory the Flue `SessionEnv` resolves relative paths
 * against. OMA's container sandboxes expose the agent workspace at
 * `/workspace`; local/dev adapters resolve their own cwd, so this is only the
 * base for relative-path resolution.
 */
const DEFAULT_CWD = "/workspace";

export class FlueHarness implements HarnessInterface {
  // Flue owns its own context window (compaction, overflow recovery, and
  // model-context projection all live inside the Flue runtime). OMA must not
  // drive any of these ports for a Flue turn — they are deliberate no-ops,
  // mirroring AcpProxyHarness.
  async onSessionInit(): Promise<void> {
    /* no-op — a Flue agent's instructions + skills come from its definition,
       not OMA's <system-reminder> event injection. */
  }

  shouldCompact(): boolean {
    return false; // Flue manages its own context window.
  }

  async compact(): Promise<void> {
    /* no-op — Flue compacts internally. */
  }

  deriveModelContext(): never[] {
    return []; // never called — OMA doesn't run generateText for a Flue turn.
  }

  async run(ctx: HarnessContext): Promise<void> {
    const runtime = ctx.runtime;

    const userText = extractUserText(ctx.userMessage);
    if (!userText) {
      this.#emitError(runtime, "Could not extract text from user message — empty turn");
      return;
    }

    // ── Provider ─────────────────────────────────────────────────────────
    const baseUrl = ctx.env.ANTHROPIC_BASE_URL;
    const apiKey = ctx.env.ANTHROPIC_API_KEY;
    const model = resolveModelId(ctx);
    if (!baseUrl) {
      this.#emitError(
        runtime,
        "FlueHarness needs a base URL (env.ANTHROPIC_BASE_URL) to register a Flue provider",
      );
      return;
    }
    if (!model) {
      this.#emitError(runtime, "FlueHarness could not resolve a model id from the agent config");
      return;
    }

    let modelSpecifier: string;
    try {
      const provider = buildFlueProvider({
        baseUrl,
        apiKey,
        model,
        api: pickApi(model, baseUrl),
      });
      registerProvider(provider.providerId, provider.registration);
      modelSpecifier = provider.modelSpecifier;
    } catch (err) {
      this.#emitError(runtime, `FlueHarness provider registration failed: ${errMessage(err)}`);
      return;
    }

    // ── Sandbox + agent ──────────────────────────────────────────────────
    const sandboxApi = createFlueSandboxApi(runtime.sandbox);
    const sandbox: SandboxFactory = {
      createSessionEnv: async () => createSandboxSessionEnv(sandboxApi, DEFAULT_CWD),
    };
    const agent = defineAgent(() => ({
      model: modelSpecifier,
      sandbox,
      instructions: ctx.systemPrompt,
    }));

    // ── Event translation + turn drive ───────────────────────────────────
    const instanceId = ctx.session_id || generateEventId();
    const translator = new FlueEventTranslator(runtime);

    let aborted = false;
    let settleAbort: (() => void) | null = null;
    const abortedSignal = new Promise<void>((resolve) => {
      settleAbort = resolve;
    });

    const unobserve = observe((event: FlueEvent) => {
      // Scope to THIS interaction — observe() sees every event in the isolate.
      if (event.instanceId !== instanceId) return;
      void translator.consume(event).catch((e) =>
        logError({ op: "flue.translate_failed", err: errMessage(e) }, "event translate failed"),
      );
    });

    const abortHandler = () => {
      aborted = true;
      settleAbort?.();
    };
    runtime.abortSignal?.addEventListener("abort", abortHandler);

    // Races the turn against an abort: on abort we stop awaiting (and mark
    // the stream aborted below) but — same as before this bridge existed —
    // do not cancel the in-flight Flue submission itself.
    const drive = async () => {
      await Promise.race([runFlueAgentTurn({ agent, instanceId, message: userText }), abortedSignal]);
    };

    try {
      if (runtime.keepAliveWhile) {
        await runtime.keepAliveWhile(drive);
      } else {
        await drive();
      }
      await translator.flush(aborted ? "aborted" : "completed");
      if (aborted) log({ op: "flue.aborted", session_id: instanceId }, "user-aborted");
    } catch (err) {
      await translator.flush("completed");
      logError(
        { op: "flue.turn_failed", session_id: instanceId, err: errMessage(err) },
        "turn failed",
      );
      this.#emitError(runtime, errMessage(err));
    } finally {
      unobserve();
      runtime.abortSignal?.removeEventListener("abort", abortHandler);
    }
  }

  #emitError(runtime: HarnessRuntime, message: string): void {
    runtime.broadcast({ type: "session.error", error: message } as SessionEvent);
  }
}

/** Extract plain text from an OMA user message's content blocks. */
function extractUserText(msg: UserMessageEvent): string {
  const content = msg.content;
  if (!Array.isArray(content)) return "";
  return (content as Array<{ type?: string; text?: string }>)
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n")
    .trim();
}

/** Resolve the upstream model id from the agent config / env. */
function resolveModelId(ctx: HarnessContext): string {
  const envModel = ctx.env.ANTHROPIC_MODEL;
  if (envModel) return envModel;
  const m = ctx.agent.model;
  return typeof m === "string" ? m : m?.id ?? "";
}

/**
 * Pick Flue's wire protocol. Anthropic-style endpoints/models use
 * `anthropic-messages`; everything else defaults to the OpenAI-compatible
 * `openai-completions` most OMA gateways speak.
 */
function pickApi(model: string, baseUrl: string): FlueProviderApi {
  const isAnthropic = model.startsWith("claude-") || /anthropic/i.test(baseUrl);
  return isAnthropic ? "anthropic-messages" : "openai-completions";
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
