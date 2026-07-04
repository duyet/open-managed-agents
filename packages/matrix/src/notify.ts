// Outbound session-status notifications — send a message to the room
// configured as a `matrix_message` NotificationTarget. Mirrors
// packages/github and packages/slack's notify.ts. See config.ts for why
// this package has no provider.ts/webhook/oauth (outbound-only scope).

import { summarizeSessionNotifyEvent, type SessionNotifyEvent } from "@duyet/oma-integrations-core";
import type { MatrixApiClient, SendMessageResult } from "./api/client";

/** Where to send — a room on a specific homeserver. */
export interface MatrixNotifyTarget {
  homeserverUrl: string;
  roomId: string;
}

/** Render a session-status event as a plain-text Matrix message. */
export function formatSessionNotifyMessage(event: SessionNotifyEvent): string {
  const marker = event.status === "error" ? "[error]" : event.status === "terminated" ? "[terminated]" : "[idle]";
  return `${marker} ${summarizeSessionNotifyEvent(event)}`;
}

/**
 * Send a session-status message to the configured room.
 *
 * `accessToken` is a live Matrix bot access token — resolving a
 * `credential_id` (see `NotificationTarget`) to this token is the caller's
 * responsibility, matching how the rest of `MatrixApiClient` takes tokens
 * directly rather than credential references.
 */
export async function postSessionStatusMessage(
  client: MatrixApiClient,
  accessToken: string,
  target: MatrixNotifyTarget,
  event: SessionNotifyEvent,
): Promise<SendMessageResult> {
  return client.sendMessage(
    accessToken,
    target.homeserverUrl,
    target.roomId,
    formatSessionNotifyMessage(event),
  );
}
