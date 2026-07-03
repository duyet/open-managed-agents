// In-process cache for an OAuth-connected AnyRouter credential.
//
// Node self-host has no per-tenant model routing (see `buildModel` in
// index.ts) — the model provider is process-global env vars
// (ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL / OMA_API_COMPAT), set once at
// deploy time. This cache extends that same "process-global, single active
// provider" model to the OAuth-connected case: whichever tenant most
// recently completed the AnyRouter connect flow becomes the node's active
// upstream, exactly as if an operator had set the env vars by hand — just
// without a restart. Multi-tenant per-agent provider selection is out of
// scope here; that's the CF-side D1 model-cards system's job.

import {
  ANYROUTER_API_BASE,
  ANYROUTER_API_COMPAT,
} from "@duyet/oma-anyrouter";
import type { CredentialService } from "@duyet/oma-credentials-store";
import type { VaultService } from "@duyet/oma-vaults-store";
import type { SqlClient } from "@duyet/oma-sql-client";

export interface AnyRouterProviderState {
  apiKey: string;
  baseUrl: string;
  compat: typeof ANYROUTER_API_COMPAT;
}

let active: AnyRouterProviderState | null = null;

export function getActiveAnyRouterProvider(): AnyRouterProviderState | null {
  return active;
}

export function setActiveAnyRouterProvider(apiKey: string): void {
  active = { apiKey, baseUrl: ANYROUTER_API_BASE, compat: ANYROUTER_API_COMPAT };
}

export function clearActiveAnyRouterProvider(): void {
  active = null;
}

/**
 * Boot-time warm: scan every tenant's vaults for an active
 * `provider: "anyrouter"` credential and populate the cache. Node self-host
 * is a small single-operator deploy, so a full scan at startup is cheap and
 * only runs once. Best-effort — a scan failure just means the node falls
 * back to env vars until the next successful OAuth connect.
 */
export async function loadActiveAnyRouterProvider(deps: {
  sql: SqlClient;
  vaults: VaultService;
  credentials: CredentialService;
}): Promise<void> {
  try {
    const tenantsResult = await deps.sql.prepare(`SELECT id FROM "tenant"`).all<{ id: string }>();
    for (const t of tenantsResult.results ?? []) {
      const vaults = await deps.vaults.list({ tenantId: t.id, includeArchived: false });
      for (const v of vaults) {
        const creds = await deps.credentials.list({
          tenantId: t.id,
          vaultId: v.id,
          includeArchived: false,
        });
        const hit = creds.find(
          (c) => c.auth?.provider === "anyrouter" && !c.archived_at && c.auth.token,
        );
        if (hit?.auth.token) {
          setActiveAnyRouterProvider(hit.auth.token);
          return;
        }
      }
    }
  } catch (err) {
    console.warn(
      `[anyrouter-provider] boot-time warm failed, falling back to env vars: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
