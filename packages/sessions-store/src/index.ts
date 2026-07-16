// Public surface of @duyet/oma-sessions-store.
//
//   - types       : SessionRow, SessionResourceRow, MAX_RESOURCES_PER_SESSION,
//                   MAX_MEMORY_STORE_RESOURCES_PER_SESSION
//   - errors      : typed errors so HTTP handlers can map → status codes
//   - ports       : abstract dependencies the service requires
//   - service     : SessionService (pure business logic, port-only deps)
//   - adapters    : Cloudflare-specific implementations + factory
//
// Callers in apps/main and apps/agent normally only need:
//   import { createCfSessionService } from "@duyet/oma-sessions-store";
// Tests use:
//   import { createInMemorySessionService } from "@duyet/oma-sessions-store/test-fakes";

export * from "./types";
export * from "./errors";
export * from "./ports";
export { SessionService, computeSessionAnalytics, normalizeRange } from "./service";
export type { SessionServiceDeps, NewResourceInput } from "./service";

export { createCfSessionService, createSqliteSessionService, SqlSessionRepo } from "./adapters";
