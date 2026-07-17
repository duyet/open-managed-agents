// Public chat surface for published agents (issue #72).
//
// The implementation moved to the shared, runtime-neutral factory
// (@duyet/oma-http-routes → packages/http-routes/src/public/publications.ts)
// so the Cloudflare worker (apps/main) and the self-host Node server
// (apps/main-node) render + behave identically (issue #226). This file is a
// thin re-export so apps/main's existing imports and tests resolve unchanged;
// the CF-specific deps (D1-backed publication resolution, per-tenant session
// app, paywall gate) are still wired at the /p mount in apps/main/src/index.ts.

export {
  buildPublicPublicationRoutes,
  gatePublicationState,
  publicSessionCaps,
  renderChatPage,
  renderWidgetScript,
} from "@duyet/oma-http-routes";
export type { PublicPublicationRoutesDeps } from "@duyet/oma-http-routes";
