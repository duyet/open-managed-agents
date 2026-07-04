// Outbound session-status notifications — post a message to the channel
// configured as a `slack_message` NotificationTarget.
//
// This is deliberately separate from provider.ts/webhook/: those implement
// the INBOUND direction (a Slack event creates or resumes a session). This
// file is OUTBOUND only (a session status change posts back to Slack) and
// doesn't touch the publication/install machinery — it just needs a bot
// token and a `SlackApiClient`.

import { summarizeSessionNotifyEvent, type SessionNotifyEvent } from "@duyet/oma-integrations-core";
import type { PostMessageResult, SlackApiClient } from "./api/client";

/** Where to post — a channel id (or DM/conversation id). */
export interface SlackNotifyTarget {
  channel: string;
}

/** Render a session-status event as a Slack mrkdwn-flavored message. */
export function formatSessionNotifyMessage(event: SessionNotifyEvent): string {
  const emoji = event.status === "error" ? ":red_circle:" : event.status === "terminated" ? ":white_circle:" : ":large_green_circle:";
  return `${emoji} ${summarizeSessionNotifyEvent(event)}`;
}

/**
 * Post a session-status message to the configured channel.
 *
 * `botToken` is a live Slack bot (`xoxb-`) token — resolving a
 * `credential_id` (see `NotificationTarget`) to this token is the caller's
 * responsibility, matching how the rest of `SlackApiClient` takes tokens
 * directly rather than credential references.
 */
export async function postSessionStatusMessage(
  client: SlackApiClient,
  botToken: string,
  target: SlackNotifyTarget,
  event: SessionNotifyEvent,
): Promise<PostMessageResult> {
  return client.postMessage(botToken, target.channel, formatSessionNotifyMessage(event));
}
