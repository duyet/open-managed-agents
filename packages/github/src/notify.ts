// Outbound session-status notifications — post a comment on the issue/PR
// configured as a `github_comment` NotificationTarget.
//
// This is deliberately separate from provider.ts/webhook/: those implement
// the INBOUND direction (a GitHub webhook creates or resumes a session).
// This file is OUTBOUND only (a session status change posts back to
// GitHub) and doesn't touch the publication/install machinery — it just
// needs an installation token and a `GitHubApiClient`.

import { summarizeSessionNotifyEvent, type SessionNotifyEvent } from "@duyet/oma-integrations-core";
import type { GitHubApiClient } from "./api/client";

/** Where to post — one issue or PR (GitHub's comments API is the same for both). */
export interface GitHubNotifyTarget {
  owner: string;
  repo: string;
  issueNumber: number;
}

/** Render a session-status event as a GitHub-flavored markdown comment. */
export function formatSessionNotifyComment(event: SessionNotifyEvent): string {
  const emoji = event.status === "error" ? "🔴" : event.status === "terminated" ? "⚪" : "🟢";
  return `${emoji} ${summarizeSessionNotifyEvent(event)}`;
}

/**
 * Post a session-status comment to the configured issue/PR.
 *
 * `installationToken` is a live GitHub App installation token (or PAT) —
 * resolving a `credential_id` (see `NotificationTarget`) to this token is
 * the caller's responsibility, matching how the rest of `GitHubApiClient`
 * takes tokens directly rather than credential references.
 */
export async function postSessionStatusComment(
  client: GitHubApiClient,
  installationToken: string,
  target: GitHubNotifyTarget,
  event: SessionNotifyEvent,
): Promise<{ id: number; htmlUrl: string }> {
  return client.createIssueComment(
    installationToken,
    target.owner,
    target.repo,
    target.issueNumber,
    formatSessionNotifyComment(event),
  );
}
