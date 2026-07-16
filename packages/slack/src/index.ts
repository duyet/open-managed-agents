// @duyet/oma-slack
//
// Slack-specific implementation of integrations-core's IntegrationProvider.
// Pure logic only — no Cloudflare imports, no Hono, no D1. All runtime
// concerns (HTTP, storage, crypto, JWT) are injected via integrations-core
// ports plus the Slack-specific SlackInstallationRepo extension.

export { SlackProvider, scopeKeyFor, SLACK_SIGNAL_PROTOCOL_PROMPT } from "./provider";
export type { SlackContainer } from "./provider";
export {
  type SlackConfig,
  type SlackCapabilityKey,
  ALL_SLACK_CAPABILITIES,
  DEFAULT_SLACK_BOT_SCOPES,
  DEFAULT_SLACK_USER_SCOPES,
  DEFAULT_SLACK_SUBSCRIBED_EVENTS,
} from "./config";
export {
  buildAuthorizeUrl,
  buildTokenExchangeBody,
  parseTokenResponse,
  type SlackTokenResponse,
  type SlackTeamInfo,
  type SlackEnterpriseInfo,
  type SlackAuthedUser,
} from "./oauth/protocol";
export {
  buildManifest,
  buildManifestLaunchUrl,
  type SlackManifestInput,
} from "./oauth/manifest";
export { generateSlackManifest } from "./manifest";
export {
  buildBaseString,
  parseSignatureHeader,
  isTimestampFresh,
  MAX_TIMESTAMP_SKEW_SECONDS,
  type ParsedSignature,
} from "./webhook/signature";
export {
  parseWebhook,
  type NormalizedSlackEvent,
  type SlackEventKind,
  type RawSlackEnvelope,
  type RawUrlVerification,
  type RawEventCallback,
  type RawAppRateLimited,
  type RawEventInner,
} from "./webhook/parse";
export {
  SlackApiClient,
  SlackApiError,
  type AuthTestResult,
  type PostMessageResult,
  type PostMessageInput,
  type UploadFileInput,
  type UploadFileResult,
  type SlackBlock,
} from "./api/client";
export {
  renderProgressBlocks,
  renderProgressText,
  renderFinalResponseBlocks,
  renderFinalResponseText,
  renderErrorBlocks,
  truncate,
  SECTION_TEXT_LIMIT,
  type ProgressStep,
  type ProgressSnapshot,
  type FinalResponseInput,
} from "./blocks";
export {
  SlackThreadReporter,
  driveSlackThread,
  type SlackSessionEvent,
  type SlackThreadTarget,
  type SlackThreadReporterOptions,
  type DriveSlackThreadOptions,
} from "./thread-reporter";
export type {
  SlackInstallationRepo,
  SlackPublicationRepo,
  SlackPublicationCredentialState,
  SlackSessionScopeRepo,
} from "./ports";
export {
  formatSessionNotifyMessage,
  postSessionStatusMessage,
  type SlackNotifyTarget,
} from "./notify";
