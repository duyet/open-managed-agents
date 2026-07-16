// @ts-nocheck
// Unit tests for Issue #91 Phase 3 — tenant-level MCP server registry.
//
// Covers the two pieces of new resolution logic:
//   1. resolveRegisteredMcpServer — KV row → { url, credential_id } lookup.
//   2. resolveProxyTargetByTenant — expanding an agent mcp_servers entry
//      that references the registry via `registry_id` (instead of an inline
//      url), including pinning a specific vault credential id, and inline
//      `url` taking precedence over `registry_id`.
//
// These exercise the credential-resolution layer directly (no sandbox,
// no service binding) which is exactly why the MCP proxy now works for
// ANY sandbox provider — the resolution is provider-agnostic.

import { describe, it, expect, beforeEach } from "vitest";
import {
  resolveRegisteredMcpServer,
  type McpRegistryRow,
} from "../../apps/main/src/routes/mcp-servers";
import { resolveProxyTargetByTenant } from "../../apps/main/src/routes/mcp-proxy";
import { InMemoryKvStore } from "../../packages/kv-store/src/adapters/in-memory";
import { createInMemoryCredentialService } from "../../packages/credentials-store/src/test-fakes";

const TENANT = "tn_test";
const VAULT = "vlt_test";
const SID = "sess_test";
const SERVER_URL = "https://linear.app/mcp";

function kvKey(id: string) {
  return `mcp_registry:${TENANT}:${id}`;
}

/** Build a fake Services with the three surfaces resolveProxyTargetByTenant
 *  touches: sessions.get, credentials.listByVaults, kv. */
function makeServices(opts: {
  kv: InMemoryKvStore;
  agentSnapshot: unknown;
  vaultIds?: string[];
}) {
  const { service: credService } = createInMemoryCredentialService();
  const services = {
    kv: opts.kv,
    credentials: credService,
    sessions: {
      async get({ sessionId }: { sessionId: string }) {
        if (sessionId !== SID) return null;
        return {
          archived_at: null,
          vault_ids: opts.vaultIds ?? [VAULT],
          agent_snapshot: opts.agentSnapshot,
        };
      },
    },
  } as unknown as Parameters<typeof resolveProxyTargetByTenant>[1];
  return { services, credService };
}

async function seedRegistry(kv: InMemoryKvStore, row: Partial<McpRegistryRow>) {
  const full: McpRegistryRow = {
    id: "mcps_abc",
    tenant_id: TENANT,
    name: "linear",
    url: SERVER_URL,
    created_at: Date.now(),
    ...row,
  };
  await kv.put(kvKey(full.id), JSON.stringify(full));
  return full;
}

describe("resolveRegisteredMcpServer", () => {
  let kv: InMemoryKvStore;
  beforeEach(() => {
    kv = new InMemoryKvStore();
  });

  it("returns url + credential_id for a stored row", async () => {
    await seedRegistry(kv, { id: "mcps_1", credential_id: "cred_9" });
    const got = await resolveRegisteredMcpServer(kv, TENANT, "mcps_1");
    expect(got).toEqual({ url: SERVER_URL, credential_id: "cred_9" });
  });

  it("returns null on miss", async () => {
    expect(await resolveRegisteredMcpServer(kv, TENANT, "mcps_missing")).toBeNull();
  });

  it("does not cross tenant boundaries", async () => {
    await seedRegistry(kv, { id: "mcps_2" });
    expect(await resolveRegisteredMcpServer(kv, "tn_other", "mcps_2")).toBeNull();
  });
});

describe("resolveProxyTargetByTenant with registry_id", () => {
  let kv: InMemoryKvStore;
  beforeEach(() => {
    kv = new InMemoryKvStore();
  });

  it("expands registry_id → url and matches a vault credential by url", async () => {
    await seedRegistry(kv, { id: "mcps_1" });
    const agentSnapshot = {
      mcp_servers: [{ name: "linear", type: "http", registry_id: "mcps_1" }],
    };
    const { services, credService } = makeServices({ kv, agentSnapshot });
    await credService.create({
      tenantId: TENANT,
      vaultId: VAULT,
      displayName: "linear token",
      auth: { type: "static_bearer", mcp_server_url: SERVER_URL, token: "tok_url" },
    });

    const target = await resolveProxyTargetByTenant({}, services, TENANT, SID, "linear");
    expect(target).toEqual({ upstreamUrl: SERVER_URL, upstreamToken: "tok_url" });
  });

  it("pins the registry's credential_id, matching by id not by url", async () => {
    const { service: credService } = createInMemoryCredentialService();
    // The pinned credential's own url does NOT match the registered server
    // url — proving selection is by id, not by url matching.
    const pinned = await credService.create({
      tenantId: TENANT,
      vaultId: VAULT,
      displayName: "pinned",
      auth: { type: "static_bearer", mcp_server_url: "https://other.example/x", token: "tok_pinned" },
    });
    await seedRegistry(kv, { id: "mcps_1", credential_id: pinned.id });
    const services = {
      kv,
      credentials: credService,
      sessions: {
        async get() {
          return {
            archived_at: null,
            vault_ids: [VAULT],
            agent_snapshot: {
              mcp_servers: [{ name: "linear", type: "http", registry_id: "mcps_1" }],
            },
          };
        },
      },
    } as unknown as Parameters<typeof resolveProxyTargetByTenant>[1];

    const target = await resolveProxyTargetByTenant({}, services, TENANT, SID, "linear");
    expect(target?.upstreamToken).toBe("tok_pinned");
  });

  it("inline url wins over registry_id", async () => {
    const inlineUrl = "https://inline.example/mcp";
    await seedRegistry(kv, { id: "mcps_1", url: "https://registry.example/mcp" });
    const agentSnapshot = {
      mcp_servers: [
        { name: "linear", type: "http", url: inlineUrl, registry_id: "mcps_1" },
      ],
    };
    const { services, credService } = makeServices({ kv, agentSnapshot });
    await credService.create({
      tenantId: TENANT,
      vaultId: VAULT,
      displayName: "inline token",
      auth: { type: "static_bearer", mcp_server_url: inlineUrl, token: "tok_inline" },
    });

    const target = await resolveProxyTargetByTenant({}, services, TENANT, SID, "linear");
    expect(target).toEqual({ upstreamUrl: inlineUrl, upstreamToken: "tok_inline" });
  });

  it("returns null when registry_id resolves no url", async () => {
    const agentSnapshot = {
      mcp_servers: [{ name: "linear", type: "http", registry_id: "mcps_missing" }],
    };
    const { services } = makeServices({ kv, agentSnapshot });
    const target = await resolveProxyTargetByTenant({}, services, TENANT, SID, "linear");
    expect(target).toBeNull();
  });
});
