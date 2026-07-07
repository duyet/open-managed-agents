// Dispatches an outbound session-status notification (SessionNotifyEvent)
// to every NotificationTarget configured on an agent (agent.notify).
//
// Extracted from session-do.ts so the fan-out logic is unit-testable
// without spinning up a Durable Object — mirrors the injected-deps style
// of outcome-supervisor.ts. session-do.ts calls this fire-and-forget after
// a session.status_idle/error/terminated event is already committed; this
// module must never throw back into the caller.

import type { HttpClient, SessionNotifyEvent } from "@duyet/oma-integrations-core";
import type { NotificationTarget } from "@duyet/oma-api-types";
import { GitHubApiClient, postSessionStatusComment } from "@duyet/oma-github";
import { SlackApiClient, postSessionStatusMessage as postSlackStatusMessage } from "@duyet/oma-slack";
import { MatrixApiClient, postSessionStatusMessage as postMatrixStatusMessage } from "@duyet/oma-matrix";

export interface NotifyDispatchDeps {
  /** Resolve a vault `credential_id` to a live bearer/bot/access token. */
  resolveCredentialToken: (credentialId?: string) => Promise<string | null>;
  httpClient: HttpClient;
  /** Optional error sink (logging) — called once per failed/skipped target. */
  onError?: (target: NotificationTarget, err: unknown) => void;
}

/**
 * Fan out `event` to every target concurrently. Never throws — a target
 * with no resolvable token, or whose provider call fails, is reported via
 * `deps.onError` (if given) and otherwise skipped; it never affects the
 * other targets.
 */
export async function dispatchSessionNotifications(
  event: SessionNotifyEvent,
  targets: readonly NotificationTarget[],
  deps: NotifyDispatchDeps,
): Promise<void> {
  if (!targets.length) return;
  await Promise.allSettled(targets.map((target) => dispatchOne(event, target, deps)));
}

async function dispatchOne(
  event: SessionNotifyEvent,
  target: NotificationTarget,
  deps: NotifyDispatchDeps,
): Promise<void> {
  try {
    const token = await deps.resolveCredentialToken(target.credential_id);
    if (!token) {
      deps.onError?.(target, new Error(`no credential token resolved for credential_id=${target.credential_id}`));
      return;
    }
    switch (target.type) {
      case "github_comment": {
        const client = new GitHubApiClient(deps.httpClient);
        await postSessionStatusComment(
          client,
          token,
          { owner: target.owner, repo: target.repo, issueNumber: target.issue_number },
          event,
        );
        return;
      }
      case "slack_message": {
        const client = new SlackApiClient(deps.httpClient);
        await postSlackStatusMessage(client, token, { channel: target.channel }, event);
        return;
      }
      case "matrix_message": {
        const client = new MatrixApiClient(deps.httpClient);
        await postMatrixStatusMessage(
          client,
          token,
          { homeserverUrl: target.homeserver_url, roomId: target.room_id },
          event,
        );
        return;
      }
    }
  } catch (err) {
    deps.onError?.(target, err);
  }
}
