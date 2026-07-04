// Provider-agnostic session-status notification shape.
//
// Outbound notifiers (packages/github, packages/slack, packages/matrix)
// each format this into a platform-specific message (GitHub markdown
// comment, Slack mrkdwn, Matrix plain-text) rather than duplicating the
// wording. Callers derive it from the session event log — see AGENTS.md's
// Event Types table — typically `session.status_idle`, `session.error`, or
// `session.status_terminated`.
//
// This is the OUTBOUND direction (session → chat/issue-tracker). It is
// unrelated to `IntegrationProvider` in provider.ts, which handles the
// INBOUND direction (chat/issue-tracker → session).

import type { SessionId } from "./domain";

export type SessionNotifyStatus = "idle" | "terminated" | "error";

export interface SessionNotifyEvent {
  sessionId: SessionId;
  status: SessionNotifyStatus;
  /** Agent display name, when known — keeps the message legible without a lookup. */
  agentName?: string;
  /** Free-form detail: idle stop_reason, terminated reason, or error message. */
  detail?: string;
  /** Deep link back to the session (e.g. console URL), when available. */
  sessionUrl?: string;
}

const STATUS_LABEL: Record<SessionNotifyStatus, string> = {
  idle: "finished and is waiting for input",
  terminated: "was terminated",
  error: "hit an error",
};

/**
 * One-line, plain-text summary shared by every provider's notify.ts. Kept
 * deliberately platform-neutral (no markdown) — callers wrap it in their
 * own formatting.
 */
export function summarizeSessionNotifyEvent(event: SessionNotifyEvent): string {
  const who = event.agentName ? `Agent "${event.agentName}"` : "The agent";
  let line = `${who} session ${event.sessionId} ${STATUS_LABEL[event.status]}.`;
  if (event.detail) line += ` ${event.detail}`;
  if (event.sessionUrl) line += ` (${event.sessionUrl})`;
  return line;
}
