// Public surface of @duyet/oma-vaults-store.

export * from "./types";
export * from "./errors";
export * from "./ports";
export { VaultService } from "./service";
export type { VaultServiceDeps } from "./service";

export { createCfVaultService, createSqliteVaultService, SqlVaultRepo } from "./adapters";
