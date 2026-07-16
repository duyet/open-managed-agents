// Auto-idle sweep: pauses sandboxes for Telegram chats that have gone quiet.
//
// Runs on a periodic tick (cron on Cloudflare, an interval timer on
// self-host Node). Pure aside from the injected `pause` call, so it's easy
// to unit test against an InMemoryTelegramChatStore without a real
// SessionCreator/sandbox.

import type { TelegramChatStore } from "./chat-store";

export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes, per issue #103

export interface IdleSweepDeps {
  store: TelegramChatStore;
  /** Pauses the session's sandbox. Should reject only on a real failure —
   *  a 409 "session mid-turn" is swallowed by the caller below so one busy
   *  chat doesn't block the rest of the sweep. */
  pause: (userId: string, sessionId: string) => Promise<void>;
  now: () => number;
  idleTimeoutMs?: number;
}

export interface IdleSweepResult {
  checked: number;
  paused: number[];
  failed: Array<{ chatId: number; error: string }>;
}

export async function sweepIdleTelegramChats(deps: IdleSweepDeps): Promise<IdleSweepResult> {
  const nowMs = deps.now();
  const threshold = deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const idle = await deps.store.listIdle(nowMs, threshold);

  const result: IdleSweepResult = { checked: idle.length, paused: [], failed: [] };

  for (const chat of idle) {
    try {
      await deps.pause(chat.userId, chat.sessionId);
      await deps.store.markPaused(chat.chatId, nowMs);
      result.paused.push(chat.chatId);
    } catch (err) {
      // A session mid-turn (409) or a transient sandbox error shouldn't
      // wedge the sweep — log it via the returned result and retry next
      // tick (lastActivityAtMs is untouched, so it stays eligible).
      result.failed.push({ chatId: chat.chatId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return result;
}
