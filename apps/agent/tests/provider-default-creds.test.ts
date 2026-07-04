// Unit tests for the static-env-var default provider fallback used when an
// agent's `model` handle matches no D1 model card (see
// resolveModelCardCredentials in ../src/runtime/session-do.ts). Pure — no
// D1, no network.

import { describe, it, expect } from "vitest";
import { resolveDefaultProviderCreds } from "../src/harness/provider";
import { ANYROUTER_API_BASE, ANYROUTER_API_COMPAT } from "@duyet/oma-anyrouter";

describe("resolveDefaultProviderCreds", () => {
  it("uses ANTHROPIC_API_KEY when set", () => {
    expect(
      resolveDefaultProviderCreds({
        ANTHROPIC_API_KEY: "sk-ant-test",
        ANTHROPIC_BASE_URL: "https://custom.example.com",
        ANYROUTER_API_KEY: "sk-ar-test",
      }),
    ).toEqual({ apiKey: "sk-ant-test", baseURL: "https://custom.example.com", apiCompat: "ant" });
  });

  it("falls back to ANYROUTER_API_KEY when ANTHROPIC_API_KEY is unset", () => {
    expect(
      resolveDefaultProviderCreds({ ANYROUTER_API_KEY: "sk-ar-test" }),
    ).toEqual({ apiKey: "sk-ar-test", baseURL: ANYROUTER_API_BASE, apiCompat: ANYROUTER_API_COMPAT });
  });

  it("prefers ANTHROPIC_API_KEY over ANYROUTER_API_KEY when both are set", () => {
    const result = resolveDefaultProviderCreds({
      ANTHROPIC_API_KEY: "sk-ant-test",
      ANYROUTER_API_KEY: "sk-ar-test",
    });
    expect(result?.apiKey).toBe("sk-ant-test");
    expect(result?.apiCompat).toBe("ant");
  });

  it("returns null when neither is configured", () => {
    expect(resolveDefaultProviderCreds({})).toBeNull();
  });
});
