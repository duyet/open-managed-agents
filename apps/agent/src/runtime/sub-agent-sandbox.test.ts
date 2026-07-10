// Unit tests for resolveSubAgentSandboxBinding — the pure decision that
// gates whether a runSubAgent turn shares the parent session's sandbox or
// gets a dedicated one for its own callable_agents.environment_id. See
// session-do.ts's runSubAgent for how this feeds createSandbox/getEnvConfig.

import { describe, it, expect } from "vitest";
import { resolveSubAgentSandboxBinding } from "./sub-agent-sandbox";

describe("resolveSubAgentSandboxBinding", () => {
  it("shares the parent sandbox when the roster entry has no environment_id", () => {
    expect(resolveSubAgentSandboxBinding(undefined, "env_parent")).toEqual({ kind: "shared" });
  });

  it("shares the parent sandbox when neither side has an environment_id", () => {
    expect(resolveSubAgentSandboxBinding(undefined, undefined)).toEqual({ kind: "shared" });
  });

  it("shares the parent sandbox when the roster entry matches the parent's environment_id", () => {
    expect(resolveSubAgentSandboxBinding("env_same", "env_same")).toEqual({ kind: "shared" });
  });

  it("mints a dedicated sandbox when the roster entry names a different environment", () => {
    expect(resolveSubAgentSandboxBinding("env_other", "env_parent")).toEqual({
      kind: "dedicated",
      environmentId: "env_other",
    });
  });

  it("mints a dedicated sandbox when the parent has no environment_id but the roster entry does", () => {
    expect(resolveSubAgentSandboxBinding("env_other", undefined)).toEqual({
      kind: "dedicated",
      environmentId: "env_other",
    });
  });
});
