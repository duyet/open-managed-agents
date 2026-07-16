// Direct hub-observer reply routing (design doc "Approach B") — used by the
// self-host Node webhook path, which has no generic `agent.notify` fan-out.
// The Telegram chat_id is dynamic per inbound message, so this attaches a
// one-shot observer to the host's event stream for exactly the session the
// webhook just created/resumed, accumulates the agent's text, and posts it
// back to the chat once the turn reaches a terminal state.
//
// Runtime-agnostic: the host supplies `subscribe` (Node: EventStreamHub.attach,
// CF: whatever the equivalent broadcast hook is) so this file has no
// dependency on any specific hub implementation.

import type { TelegramClient } from "./client";

export interface TelegramReplyEvent {
  type: string;
  content?: ReadonlyArray<{ type: string; text?: string }>;
  [k: string]: unknown;
}

export type TelegramReplySubscribe = (
  sessionId: string,
  onEvent: (event: TelegramReplyEvent) => void,
) => () => void;

export interface AttachTelegramReplyOpts {
  sessionId: string;
  chatId: number;
  client: TelegramClient;
  subscribe: TelegramReplySubscribe;
  log?: { warn(o: unknown, m: string): void };
}

const TERMINAL_EVENT_TYPES = new Set([
  "session.status_idle",
  "session.status_terminated",
  "session.error",
]);

/**
 * Attaches a one-shot observer that accumulates `agent.message` text for
 * `sessionId` and, on the turn's terminal event, posts the accumulated text
 * to the Telegram chat as a single plain-text message (no `parse_mode` —
 * arbitrary agent text would break Telegram's HTML/MarkdownV2 escaping
 * rules). Sends nothing if no text was accumulated. Never throws — send
 * failures are caught and logged.
 *
 * Returns an unsubscribe function; also unsubscribes itself once the
 * terminal event fires.
 */
export function attachTelegramReply(opts: AttachTelegramReplyOpts): () => void {
  const chunks: string[] = [];
  let done = false;

  const unsubscribe = opts.subscribe(opts.sessionId, (event) => {
    if (done) return;

    if (event.type === "agent.message") {
      const text = (event.content ?? [])
        .filter((block): block is { type: string; text: string } => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("");
      if (text) chunks.push(text);
      return;
    }

    if (!TERMINAL_EVENT_TYPES.has(event.type)) return;
    done = true;

    const finalText = chunks.join("\n\n");
    if (finalText) {
      opts.client.sendMessage({ chat_id: opts.chatId, text: finalText }).catch((err) => {
        opts.log?.warn(
          { err, session_id: opts.sessionId, chat_id: opts.chatId },
          "telegram reply send failed",
        );
      });
    }
    unsubscribe();
  });

  return unsubscribe;
}
