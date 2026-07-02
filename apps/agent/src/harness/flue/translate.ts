/**
 * Translate Flue runtime events into OMA `SessionEvent`s.
 *
 * Flue emits a well-bounded event stream per agent interaction (see
 * `FlueEventVariant` in `@flue/runtime`): `text_delta` for streaming assistant
 * text, `thinking_start` / `thinking_delta` / `thinking_end` for reasoning,
 * and `tool_start` / `tool` for tool calls and their results. Unlike ACP,
 * boundaries are explicit — but we still finalize the in-flight assistant
 * message on any event that breaks its contiguous text run (a thinking block,
 * a tool call, an explicit `message_end`, or turn flush), mirroring the
 * boundary handling in `acp-translate.ts`.
 *
 * Output contract per assistant message:
 *   - `agent.message_stream_start` once at the first token
 *   - `agent.message_chunk` for every delta (broadcast-only, not persisted)
 *   - `agent.message_stream_end` when the message closes
 *   - `agent.message` once with the final text (this IS persisted)
 * Thinking uses the `agent.thinking_*` + `agent.thinking` equivalents.
 * Tool calls become `agent.tool_use` + `agent.tool_result`.
 */

import { generateEventId } from "@open-managed-agents/shared";
import type { FlueEvent } from "@flue/runtime";
import type { HarnessRuntime } from "../interface";

/** Render an arbitrary Flue tool result into the text OMA's event carries. */
function stringifyToolResult(result: unknown, isError: boolean): string {
  if (typeof result === "string") return result;
  if (result == null) return isError ? "(tool error)" : "(no result)";
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

/**
 * Per-interaction streaming translator. One instance per `FlueHarness.run`
 * call. Feed every scoped Flue event to {@link consume}; call {@link flush} at
 * turn end to close any still-open message / thinking block.
 */
export class FlueEventTranslator {
  readonly #runtime: HarnessRuntime;
  #activeMessage: { id: string; text: string } | null = null;
  #activeThinking: { id: string; text: string } | null = null;

  constructor(runtime: HarnessRuntime) {
    this.#runtime = runtime;
  }

  async consume(event: FlueEvent): Promise<void> {
    switch (event.type) {
      case "text_delta":
        await this.#onTextChunk(event.text);
        break;
      case "message_end":
        // Explicit assistant-message boundary — finalize whatever we streamed.
        await this.#closeMessage();
        break;
      case "thinking_start":
        await this.#closeMessage();
        await this.#openThinking();
        break;
      case "thinking_delta":
        await this.#onThinkingChunk(event.delta);
        break;
      case "thinking_end":
        await this.#closeThinking(event.content);
        break;
      case "tool_start":
        // A tool call breaks the assistant's text/thinking run.
        await this.#closeMessage();
        await this.#closeThinking();
        this.#runtime.broadcast({
          type: "agent.tool_use",
          id: event.toolCallId,
          name: event.toolName,
          input: (event.args as Record<string, unknown> | undefined) ?? {},
        });
        break;
      case "tool":
        this.#runtime.broadcast({
          type: "agent.tool_result",
          tool_use_id: event.toolCallId,
          content: stringifyToolResult(event.result, event.isError),
        });
        break;
      case "log":
        if (event.level === "error") {
          this.#runtime.broadcast({
            type: "session.warning",
            source: "flue",
            message: event.message,
          });
        }
        break;
      default:
        // run_start / turn_* / operation_* / idle / … carry no OMA-canonical
        // surface yet. Drop silently — dropping keeps the turn alive.
        break;
    }
  }

  /** Close any open message / thinking block at the interaction boundary. */
  async flush(reason: "completed" | "aborted" = "completed"): Promise<void> {
    if (reason === "aborted") {
      if (this.#activeMessage) {
        await this.#runtime.broadcastStreamEnd(this.#activeMessage.id, "aborted");
        this.#activeMessage = null;
      }
      if (this.#activeThinking) {
        await this.#runtime.broadcastThinkingEnd(this.#activeThinking.id, "aborted");
        this.#activeThinking = null;
      }
      return;
    }
    await this.#closeMessage();
    await this.#closeThinking();
  }

  async #onTextChunk(delta: string): Promise<void> {
    if (this.#activeThinking) await this.#closeThinking();
    if (!this.#activeMessage) {
      const id = generateEventId();
      this.#activeMessage = { id, text: "" };
      await this.#runtime.broadcastStreamStart(id);
    }
    this.#activeMessage.text += delta;
    await this.#runtime.broadcastChunk(this.#activeMessage.id, delta);
  }

  async #openThinking(): Promise<void> {
    if (this.#activeThinking) return;
    const id = generateEventId();
    this.#activeThinking = { id, text: "" };
    await this.#runtime.broadcastThinkingStart(id);
  }

  async #onThinkingChunk(delta: string): Promise<void> {
    if (this.#activeMessage) await this.#closeMessage();
    if (!this.#activeThinking) await this.#openThinking();
    // #openThinking always assigns; the guard above guarantees non-null here.
    this.#activeThinking!.text += delta;
    await this.#runtime.broadcastThinkingChunk(this.#activeThinking!.id, delta);
  }

  async #closeMessage(): Promise<void> {
    const m = this.#activeMessage;
    if (!m) return;
    this.#activeMessage = null;
    await this.#runtime.broadcastStreamEnd(m.id, "completed");
    this.#runtime.broadcast({
      type: "agent.message",
      message_id: m.id,
      content: [{ type: "text", text: m.text.replace(/\s+$/, "") }],
    });
  }

  /**
   * Close the active thinking block. Prefers Flue's canonical `content` from
   * `thinking_end` when present, falling back to the streamed accumulation.
   */
  async #closeThinking(content?: string): Promise<void> {
    const t = this.#activeThinking;
    if (!t) return;
    this.#activeThinking = null;
    await this.#runtime.broadcastThinkingEnd(t.id, "completed");
    const text = (content ?? t.text).replace(/\s+$/, "");
    this.#runtime.broadcast({
      type: "agent.thinking",
      text,
      thinking_id: t.id,
    });
  }
}
