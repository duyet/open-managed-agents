// Unit tests for ClaudeAgentSdkHarness's CLI subprocess auth selection.
// Pure — no CLI subprocess, no LLM, no import of @anthropic-ai/claude-agent-sdk
// (see the module-level note in ../src/harness/claude-agent-sdk/auth.ts).

import { describe, it, expect } from "vitest";
import { resolveClaudeSdkAuth } from "../src/harness/claude-agent-sdk/auth";

describe("resolveClaudeSdkAuth", () => {
  it("uses ANTHROPIC_API_KEY when set", () => {
    expect(
      resolveClaudeSdkAuth({ ANTHROPIC_API_KEY: "sk-ant-test", CLAUDE_CODE_OAUTH_TOKEN: undefined }),
    ).toEqual({ ANTHROPIC_API_KEY: "sk-ant-test" });
  });

  it("falls back to CLAUDE_CODE_OAUTH_TOKEN when ANTHROPIC_API_KEY is absent", () => {
    expect(
      resolveClaudeSdkAuth({ ANTHROPIC_API_KEY: undefined, CLAUDE_CODE_OAUTH_TOKEN: "oauth-token-test" }),
    ).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-token-test" });
  });

  it("falls back to CLAUDE_CODE_OAUTH_TOKEN when ANTHROPIC_API_KEY is an empty string", () => {
    // HarnessContext.env.ANTHROPIC_API_KEY is typed as a required string —
    // an unset Worker secret surfaces as "", not undefined.
    expect(
      resolveClaudeSdkAuth({ ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "oauth-token-test" }),
    ).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-token-test" });
  });

  it("prefers ANTHROPIC_API_KEY when both are set", () => {
    expect(
      resolveClaudeSdkAuth({ ANTHROPIC_API_KEY: "sk-ant-test", CLAUDE_CODE_OAUTH_TOKEN: "oauth-token-test" }),
    ).toEqual({ ANTHROPIC_API_KEY: "sk-ant-test" });
  });

  it("returns null when neither is set", () => {
    expect(resolveClaudeSdkAuth({})).toBeNull();
  });
});
