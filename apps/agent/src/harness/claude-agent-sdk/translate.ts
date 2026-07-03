/**
 * Translate Claude Agent SDK messages into OMA `SessionEvent`s.
 *
 * `query(...)` streams a `SDKMessage` union per `for await` iteration. This
 * harness only consumes the subset needed to project onto OMA's wire event
 * contract:
 *   - `assistant` messages carry a raw Anthropic `BetaMessage` in `.message`
 *     — its `content[]` blocks (text / thinking / tool_use) map directly
 *     onto `agent.message` / `agent.thinking` / `agent.tool_use`.
 *   - `user` messages are the CLI's own synthesized echo of a resolved tool
 *     call (`message.content` carries `tool_result` blocks) — these map to
 *     `agent.tool_result`.
 *   - `result` is the terminal per-turn summary (usage, cost, stop reason).
 * Every other SDKMessage kind (hook lifecycle, task-progress, permission-
 * denied notices, partial `stream_event` deltas, plugin/auth/model-refusal
 * notices, etc.) is dropped silently — mirroring the `default:` branch in
 * `../flue/translate.ts`.
 *
 * NOTE on live streaming: events are emitted at *message* granularity (one
 * `agent.message` once the SDK has assembled a full text block), not at
 * token-delta granularity like DefaultHarness / FlueHarness's live
 * `broadcastChunk`. `includePartialMessages` would add token-level
 * streaming via `stream_event` messages carrying a raw Anthropic
 * `BetaRawMessageStreamEvent`, but correlating each partial content-block
 * index back to its eventual canonical block requires matching the
 * underlying Anthropic message id across a `stream_event`'s `message_start`
 * and the terminal `SDKAssistantMessage.message.id` — behavior that needs a
 * live run against the real CLI binary to validate rather than guess.
 * Documented follow-up; turn-level events are fully correct without it.
 */

import { generateEventId } from "@open-managed-agents/shared";
import type { ContentBlock, SessionEvent } from "@open-managed-agents/shared";
import type { SDKMessage, SDKAssistantMessage, SDKUserMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { HarnessRuntime } from "../interface";

/**
 * Loosely-typed Anthropic content block shapes — same pragmatic looseness
 * `../flue/translate.ts` and `../default-loop.ts` already use for raw
 * provider payloads instead of pulling in the full `@anthropic-ai/sdk`
 * content-block type graph.
 */
type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: string; [key: string]: unknown };

type AnthropicToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  is_error?: boolean;
  content?: string | Array<{ type: string; text?: string; source?: unknown }>;
};

/** Anthropic `tool_result` content → OMA's `string | ContentBlock[]` wire shape. */
function normalizeToolResultContent(block: AnthropicToolResultBlock): string | ContentBlock[] {
  const { content } = block;
  if (content == null) return block.is_error ? "(tool error)" : "";
  if (typeof content === "string") return content;
  const blocks: ContentBlock[] = content.map((part): ContentBlock => {
    if (part.type === "text") return { type: "text", text: part.text ?? "" };
    if (part.type === "image" && part.source) {
      // Anthropic's tool_result image source shape (base64/url + media_type)
      // is structurally compatible with OMA's ImageBlock["source"]; loosely
      // typed here for the same reason default-loop.ts/flue/translate.ts
      // cast raw provider payloads instead of re-deriving the full type.
      return {
        type: "image",
        source: part.source as { type: "base64" | "url" | "file"; media_type?: string; data?: string; url?: string },
      };
    }
    return { type: "text", text: JSON.stringify(part) };
  });
  return blocks;
}

export class ClaudeAgentSdkEventTranslator {
  readonly #runtime: HarnessRuntime;
  #resultMessage: SDKResultMessage | null = null;
  #sawAssistantOutput = false;

  constructor(runtime: HarnessRuntime) {
    this.#runtime = runtime;
  }

  /** The terminal `result` message for this turn, once seen. */
  get result(): SDKResultMessage | null {
    return this.#resultMessage;
  }

  /** Whether any `agent.message` / `agent.tool_use` was emitted this turn. */
  get sawAssistantOutput(): boolean {
    return this.#sawAssistantOutput;
  }

  async consume(message: SDKMessage): Promise<void> {
    switch (message.type) {
      case "assistant":
        this.#consumeAssistant(message);
        break;
      case "user":
        this.#consumeUser(message);
        break;
      case "result":
        this.#resultMessage = message;
        break;
      default:
        // system / stream_event / hook_* / task_* / auth_status / etc. —
        // no OMA-canonical surface for these yet. Dropping keeps the turn
        // alive, same rationale as flue/translate.ts's default branch.
        break;
    }
  }

  #consumeAssistant(message: SDKAssistantMessage): void {
    if (message.error) {
      this.#runtime.broadcast({
        type: "session.error",
        error: `Claude Agent SDK: ${message.error}`,
      } as SessionEvent);
      return;
    }
    const content = (message.message.content ?? []) as AnthropicContentBlock[];
    for (const block of content) {
      switch (block.type) {
        case "text": {
          const text = (block as { text: string }).text.replace(/\s+$/, "");
          if (!text) break;
          this.#sawAssistantOutput = true;
          this.#runtime.broadcast({
            type: "agent.message",
            message_id: generateEventId(),
            content: [{ type: "text", text }],
          } as SessionEvent);
          break;
        }
        case "thinking": {
          const text = (block as { thinking: string }).thinking;
          this.#runtime.broadcast({
            type: "agent.thinking",
            text,
          } as SessionEvent);
          break;
        }
        case "tool_use": {
          const b = block as { id: string; name: string; input: Record<string, unknown> };
          this.#sawAssistantOutput = true;
          this.#runtime.broadcast({
            type: "agent.tool_use",
            id: b.id,
            name: b.name,
            input: b.input ?? {},
          } as SessionEvent);
          break;
        }
        // redacted_thinking / server_tool_use / other block kinds: no
        // Anthropic-hosted server tools are enabled on this harness (see
        // claude-agent-sdk-loop.ts — tools:[] disables the CLI's built-ins,
        // and the only mcpServer registered is OMA's own sandbox bridge),
        // so these should not occur. Skip rather than throw if they ever do.
        default:
          break;
      }
    }
  }

  #consumeUser(message: SDKUserMessage): void {
    const content = message.message.content;
    if (!Array.isArray(content)) return;
    for (const block of content as AnthropicToolResultBlock[]) {
      if (block.type !== "tool_result") continue;
      this.#runtime.broadcast({
        type: "agent.tool_result",
        tool_use_id: block.tool_use_id,
        content: normalizeToolResultContent(block),
        parent_event_id: block.tool_use_id,
      } as SessionEvent);
    }
  }
}
