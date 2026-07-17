// Public consumer surface — the runtime-neutral factories shared by the
// Cloudflare worker (apps/main) and the self-host Node server (apps/main-node)
// so `/p/:slug` (hosted chat page, widget, public session/message
// pass-throughs) and `/v1/public/auth/*` (consumer auth) render and behave
// identically on both (issue #226).

export {
  buildPublicPublicationRoutes,
  gatePublicationState,
  publicSessionCaps,
  renderChatPage,
  renderWidgetScript,
} from "./publications";
export type {
  PublicPublicationRoutesDeps,
  PublicPublicationServices,
  PublicEnv,
} from "./publications";

export {
  buildConsumerAuthRoutes,
  createSqlConsumerAuthStore,
  magicLinkEmailHtml,
  magicLinkEmailText,
  magicLinkVerifyUrl,
  verifyMagicLinkToken,
  MAGIC_LINK_EMAIL_SUBJECT,
} from "./consumer-auth";
export type {
  ConsumerAuthRoutesDeps,
  ConsumerAuthStore,
  ConsumerAuthEmail,
  ConsumerSessionRow,
  VerifyMagicLinkOk,
  VerifyMagicLinkErr,
  VerifyMagicLinkResult,
} from "./consumer-auth";
