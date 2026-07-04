// Matrix Client-Server API configuration.
//
// Unlike GitHub/Slack, this package does NOT implement `IntegrationProvider`
// (no OAuth install flow, no inbound webhook receiver) — issue #23 only
// asks for outbound session-status notifications via a bot's existing
// access token + room id, analogous to Slack's bot-token + channel. A
// Matrix Application Service (the inbound equivalent of a GitHub App /
// Slack app) is a materially different, much larger integration and is
// out of scope here; see `notify.ts` for what IS implemented.

/** Default message type for `m.room.message` events sent by `sendMessage`. */
export const DEFAULT_MATRIX_MSGTYPE = "m.text";

export interface MatrixConfig {
  /**
   * Default homeserver base origin (e.g. "https://matrix.org"), used when a
   * `NotificationTarget` doesn't carry its own `homeserver_url`. Optional —
   * every target in practice specifies its own homeserver since a bot's
   * access token is only valid on the homeserver that issued it.
   */
  defaultHomeserverUrl?: string;
}
