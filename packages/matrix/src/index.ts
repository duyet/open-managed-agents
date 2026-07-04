// @duyet/oma-matrix
//
// Matrix (Element) outbound session-status notifications via the Matrix
// Client-Server API. Pure logic only — no Cloudflare imports, no Hono, no
// D1. HTTP is injected via integrations-core's HttpClient port, same as
// packages/github and packages/slack.
//
// Scope: outbound-only (send a message as a bot into a room). Unlike
// packages/github and packages/slack, there is no `IntegrationProvider`,
// OAuth install flow, or inbound webhook receiver here — a Matrix
// Application Service (the inbound equivalent) is a materially larger,
// separate integration that issue #23 doesn't ask for. See config.ts.

export {
  type MatrixConfig,
  DEFAULT_MATRIX_MSGTYPE,
} from "./config";
export {
  MatrixApiClient,
  MatrixApiError,
  type SendMessageResult,
} from "./api/client";
export {
  formatSessionNotifyMessage,
  postSessionStatusMessage,
  type MatrixNotifyTarget,
} from "./notify";
