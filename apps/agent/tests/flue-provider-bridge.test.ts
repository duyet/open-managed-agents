// Unit tests for the OMA→Flue provider bridge. Pure — no registry side
// effects, no network. Verifies the provider id / model specifier / registration
// the harness later feeds to Flue's registerProvider(...).

import { describe, it, expect } from "vitest";
import { buildFlueProvider } from "../src/harness/flue/provider-bridge";

describe("buildFlueProvider", () => {
  it("defaults to the 'oma' provider id and openai-completions protocol", () => {
    const p = buildFlueProvider({
      baseUrl: "https://gw.example.com/v1",
      apiKey: "sk-test",
      model: "gpt-oss-120b",
    });
    expect(p.providerId).toBe("oma");
    expect(p.modelSpecifier).toBe("oma/gpt-oss-120b");
    expect(p.registration).toEqual({
      api: "openai-completions",
      baseUrl: "https://gw.example.com/v1",
      apiKey: "sk-test",
    });
  });

  it("honors an explicit provider id and api", () => {
    const p = buildFlueProvider({
      providerId: "gateway",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "sk-ant",
      model: "claude-sonnet-4-6",
    });
    expect(p.providerId).toBe("gateway");
    expect(p.modelSpecifier).toBe("gateway/claude-sonnet-4-6");
    expect(p.registration.api).toBe("anthropic-messages");
  });

  it("preserves a model id that itself contains slashes", () => {
    const p = buildFlueProvider({
      baseUrl: "https://gw/v1",
      apiKey: "k",
      model: "moonshotai/kimi-k2",
    });
    expect(p.modelSpecifier).toBe("oma/moonshotai/kimi-k2");
  });

  it("attaches headers only when provided", () => {
    const withHeaders = buildFlueProvider({
      baseUrl: "https://gw/v1",
      apiKey: "k",
      model: "m",
      headers: { "x-team": "oma" },
    });
    expect(withHeaders.registration.headers).toEqual({ "x-team": "oma" });

    const withoutHeaders = buildFlueProvider({ baseUrl: "https://gw/v1", apiKey: "k", model: "m" });
    expect(withoutHeaders.registration.headers).toBeUndefined();
  });

  it("trims whitespace on provider id, base url, and model", () => {
    const p = buildFlueProvider({
      providerId: "  edge  ",
      baseUrl: "  https://gw/v1  ",
      apiKey: "k",
      model: "  m  ",
    });
    expect(p.providerId).toBe("edge");
    expect(p.registration.baseUrl).toBe("https://gw/v1");
    expect(p.modelSpecifier).toBe("edge/m");
  });

  it("throws when baseUrl, apiKey, or model is blank", () => {
    expect(() => buildFlueProvider({ baseUrl: "", apiKey: "k", model: "m" })).toThrow(/baseUrl/);
    expect(() => buildFlueProvider({ baseUrl: "u", apiKey: "", model: "m" })).toThrow(/apiKey/);
    expect(() => buildFlueProvider({ baseUrl: "u", apiKey: "k", model: "  " })).toThrow(/model/);
  });
});
