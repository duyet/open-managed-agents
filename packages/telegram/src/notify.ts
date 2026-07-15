import type { TelegramClient, SendMessageParams } from "./client";
import { summarizeSessionNotifyEvent, type SessionNotifyEvent } from "@duyet/oma-integrations-core";

export interface TelegramNotifyTarget {
  chatId: number;
}

export function formatTelegramNotifyMessage(event: SessionNotifyEvent): string {
  const icon = event.status === "error" ? "\u274C" : event.status === "terminated" ? "\u26AA" : "\u2705";
  return `${icon} ${summarizeSessionNotifyEvent(event)}`;
}

export async function postTelegramMessage(
  client: TelegramClient,
  target: TelegramNotifyTarget,
  event: SessionNotifyEvent,
): Promise<void> {
  await client.sendMessage({
    chat_id: target.chatId,
    text: formatTelegramNotifyMessage(event),
    parse_mode: "HTML",
  });
}
