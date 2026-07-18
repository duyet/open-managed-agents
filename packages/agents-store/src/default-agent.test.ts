import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_INPUT,
  SENIOR_ENGINEER_AGENT_INPUT,
  seedDefaultAgent,
} from "./default-agent";
import { createInMemoryAgentService } from "./test-fakes";

describe("seedDefaultAgent", () => {
  it("creates a General agent scoped to the given tenant", async () => {
    const { service } = createInMemoryAgentService();

    const row = await seedDefaultAgent(service, "tn_new");

    expect(row.tenant_id).toBe("tn_new");
    expect(row.name).toBe("General");
    expect(row.model).toBe("claude-sonnet-4-6");
    expect(row.harness).toBe("default");
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
    expect(tenantAAgents).toHaveLength(2);
    const tenantBAgents = await service.list({ tenantId: "tn_b" });
    expect(tenantBAgents).toHaveLength(2);
  });

  it("also seeds the Senior Engineer implementation agent", async () => {
    const { service } = createInMemoryAgentService();

    await seedDefaultAgent(service, "tn_se");
    const all = await service.list({ tenantId: "tn_se" });

    expect(all.map((a) => a.name).sort()).toEqual(["General", "Senior Engineer"]);
    const se = all.find((a) => a.name === "Senior Engineer")!;
    expect(se.model).toBe(SENIOR_ENGINEER_AGENT_INPUT.model);
    expect(se.tools).toEqual([{ type: "agent_toolset_20260401" }]);
    expect(se.system).toContain("implementation engineer");
  });

  it("uses the shared DEFAULT_AGENT_INPUT for every seed call", async () => {
    const { service } = createInMemoryAgentService();

    const row = await seedDefaultAgent(service, "tn_x");

    expect(row.name).toBe(DEFAULT_AGENT_INPUT.name);
    expect(row.model).toBe(DEFAULT_AGENT_INPUT.model);
    expect(row.tools).toEqual(DEFAULT_AGENT_INPUT.tools);
  });
});
