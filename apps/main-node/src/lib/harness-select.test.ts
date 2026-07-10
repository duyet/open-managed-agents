import { describe, expect, it } from "vitest";
import { selectHarnessName } from "./harness-select";

describe("selectHarnessName", () => {
  it("uses the agent's metadata.harness when set", () => {
    expect(selectHarnessName("flue", "claude-agent-sdk")).toBe("flue");
  });

  it("falls back to DEFAULT_HARNESS when metadata.harness is unset", () => {
    expect(selectHarnessName(undefined, "claude-agent-sdk")).toBe("claude-agent-sdk");
  });

  it("returns undefined (default harness) when neither is set", () => {
    expect(selectHarnessName(undefined, undefined)).toBeUndefined();
    expect(selectHarnessName(undefined, "")).toBeUndefined();
  });

  it("ignores a non-string metadata.harness value", () => {
    expect(selectHarnessName(123, "claude-agent-sdk")).toBe("claude-agent-sdk");
  });
});
