// Composition for the Telegram bot: builds a TelegramAgentHandler (and the
// TelegramClient it wraps) from env, sharing one chat-session store across
// the webhook route and the cron-driven auto-idle sweep within a given
// Worker isolate.
//
// The in-memory TelegramChatStore does NOT survive isolate recycling or
// fan-out across multiple isolates — acceptable for a single-instance
// self-host deployment, a known limitation for horizontally-scaled ones
// (see chat-store.ts doc comment). Swap in a durable TelegramChatStore
// implementation there if that becomes a problem.

import {
  TelegramAgentHandler,
  TelegramClient,
  InMemoryTelegramChatStore,
  type TelegramChatStore,
} from "@duyet/oma-telegram";
import { buildContainer } from "../../wire";
import type { Env } from "../../env";

// Module-scope singleton — reused across requests/cron ticks in the same
// isolate, matching how `sessionMap` worked before this refactor.
const sharedStore: TelegramChatStore = new InMemoryTelegramChatStore();

export interface TelegramConfigError {
  reason: string;
}

/**
 * Returns null when the bot isn't fully configured (missing token/agent
 * binding) — callers should surface a clear 503 rather than silently
 * no-op'ing.
 */
export function buildTelegramHandler(env: Env): TelegramAgentHandler | null {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_AGENT_ID) return null;

  const client = new TelegramClient(env.TELEGRAM_BOT_TOKEN);
  const container = buildContainer(env);
  const vaultIds = (env.TELEGRAM_VAULT_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return new TelegramAgentHandler(client, {
    sessions: container.sessions,
    agentId: env.TELEGRAM_AGENT_ID,
    vaultIds,
    environmentId: env.TELEGRAM_ENVIRONMENT_ID,
    store: sharedStore,
  });
}

export function telegramIdleTimeoutMs(env: Env): number | undefined {
  const raw = env.TELEGRAM_IDLE_TIMEOUT_MS;
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export { sharedStore as telegramChatStore };
