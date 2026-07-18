// Verifies buildTools generates a `call_remote_agent_*` tool for a
// `type: "remote_agent"` callable_agents entry (issue #132) and routes its
// execution through env.delegateToRemoteAgent.

import { describe, it, expect } from "vitest";
import { buildTools } from "./tools";
import type { AgentConfig } from "@duyet/oma-api-types";
import type { SandboxExecutor } from "./interface";

const fakeSandbox = {
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  writeFile: async () => {},
  destroy: async () => {},
} as unknown as SandboxExecutor;

function baseAgent(overrides: Partial<AgentConfig>): AgentConfig {
  return {
    id: "agent_1",
    name: "Test",
    model: "claude-sonnet-4-6",
    system: "",
    tools: [],
    version: 1,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("federation call_remote_agent tool", () => {
  it("generates a call_remote_agent_* tool and delegates to it", async () => {
    const calls: Array<[string, string, string, string | undefined]> = [];
    const agent = baseAgent({
      callable_agents: [
        { type: "remote_agent", instance_id: "fed_abc", remote_agent_id: "agent_xyz" },
      ],
    });
    const tools = (await buildTools(agent, fakeSandbox, {
      ANTHROPIC_API_KEY: "sk-test",
      delegateToRemoteAgent: async (instanceId, remoteAgentId, message, remoteEnvId) => {
        calls.push([instanceId, remoteAgentId, message, remoteEnvId]);
        return "remote reply";
      },
    })) as Record<string, { execute: (args: unknown) => Promise<unknown> }>;

    const toolName = "call_remote_agent_fed_abc_agent_xyz";
    expect(tools[toolName]).toBeDefined();
    // No local-delegation tools should be generated for a remote-only roster.
    expect(tools.call_agents_parallel).toBeUndefined();
    expect(tools.call_agent_agent_xyz).toBeUndefined();

    const out = await tools[toolName].execute({ message: "do it" });
    expect(out).toBe("remote reply");
    expect(calls).toEqual([["fed_abc", "agent_xyz", "do it", undefined]]);
  });

  it("returns an unavailable message when no remote executor is wired", async () => {
    const agent = baseAgent({
      callable_agents: [
        { type: "remote_agent", instance_id: "fed_abc", remote_agent_id: "agent_xyz" },
      ],
    });
    const tools = (await buildTools(agent, fakeSandbox, {
      ANTHROPIC_API_KEY: "sk-test",
    })) as Record<string, { execute: (args: unknown) => Promise<unknown> }>;
    const out = await tools.call_remote_agent_fed_abc_agent_xyz.execute({ message: "x" });
    expect(String(out)).toMatch(/not available/);
  });
});
