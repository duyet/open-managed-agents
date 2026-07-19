import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_INPUT, seedDefaultAgent } from "./default-agent";
import { createInMemoryAgentService } from "./test-fakes";

describe("seedDefaultAgent", () => {
  it("creates a General agent scoped to the given tenant", async () => {
    const { service } = createInMemoryAgentService();

    const row = await seedDefaultAgent(service, "tn_new");

    expect(row.tenant_id).toBe("tn_new");
    expect(row.name).toBe("General");
    expect(row.model).toBe("claude-sonnet-4-6");
    expect(row.tools).toEqual([{ type: "agent_toolset_20260401" }]);
    expect(row.system).toBeTruthy();
    expect(row.description).toBeTruthy();
  });

  it("is retrievable via the service afterwards", async () => {
    const { service } = createInMemoryAgentService();

    const created = await seedDefaultAgent(service, "tn_a");
    const fetched = await service.get({ tenantId: "tn_a", agentId: created.id });

    expect(fetched).not.toBeNull();
    expect(fetched?.name).toBe("General");
  });

  it("does not leak across tenants", async () => {
    const { service } = createInMemoryAgentService();

    const rowA = await seedDefaultAgent(service, "tn_a");
    await seedDefaultAgent(service, "tn_b");

    const fromOtherTenant = await service.get({ tenantId: "tn_b", agentId: rowA.id });
    expect(fromOtherTenant).toBeNull();

    const tenantAAgents = await service.list({ tenantId: "tn_a" });
    expect(tenantAAgents).toHaveLength(1);
    const tenantBAgents = await service.list({ tenantId: "tn_b" });
    expect(tenantBAgents).toHaveLength(1);
  });

  it("uses the shared DEFAULT_AGENT_INPUT for every seed call", async () => {
    const { service } = createInMemoryAgentService();

    const row = await seedDefaultAgent(service, "tn_x");

    expect(row.name).toBe(DEFAULT_AGENT_INPUT.name);
    expect(row.model).toBe(DEFAULT_AGENT_INPUT.model);
    expect(row.tools).toEqual(DEFAULT_AGENT_INPUT.tools);
  });
});
