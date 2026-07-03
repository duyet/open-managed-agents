// Public surface of @duyet/oma-model-cards-store.
//
//   - types       : ModelCardRow, apiKeyPreview helper
//   - errors      : typed errors so HTTP handlers can map → status codes
//   - ports       : abstract dependencies the service requires
//   - service     : ModelCardService (pure business logic, port-only deps)
//   - adapters    : Cloudflare-specific implementations + factory
//
// Callers in apps/main and apps/agent normally only need:
//   import { createCfModelCardService } from "@duyet/oma-model-cards-store";
// Tests use:
//   import { createInMemoryModelCardService } from "@duyet/oma-model-cards-store/test-fakes";

export * from "./types";
export * from "./errors";
export * from "./ports";
export { ModelCardService } from "./service";
export type { ModelCardServiceDeps } from "./service";

export { createCfModelCardService, createSqliteModelCardService, SqlModelCardRepo } from "./adapters";
