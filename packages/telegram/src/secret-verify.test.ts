import { describe, expect, it } from "vitest";
import { constantTimeEqual, verifyTelegramWebhookSecret } from "./secret-verify";

describe("constantTimeEqual", () => {
  it("returns true for identical strings", () => {
    expect(constantTimeEqual("shh-secret", "shh-secret")).toBe(true);
  });

  it("returns false for different strings of the same length", () => {
    expect(constantTimeEqual("shh-secret", "shh-secrex")).toBe(false);
  });

  it("returns false for strings of different lengths", () => {
    expect(constantTimeEqual("short", "much-longer-string")).toBe(false);
    expect(constantTimeEqual("much-longer-string", "short")).toBe(false);
  });

  it("returns true for two empty strings", () => {
    expect(constantTimeEqual("", "")).toBe(true);
  });
});

describe("verifyTelegramWebhookSecret", () => {
  it("passes through when no secret is configured", () => {
    expect(verifyTelegramWebhookSecret({ headerValue: null })).toEqual({ ok: true, status: 200 });
    expect(verifyTelegramWebhookSecret({ configuredSecret: "", headerValue: "anything" })).toEqual({
      ok: true,
      status: 200,
    });
  });

  it("401s when configured but the header is missing", () => {
    expect(verifyTelegramWebhookSecret({ configuredSecret: "wh-secret", headerValue: null })).toEqual({
      ok: false,
      status: 401,
    });
    expect(
      verifyTelegramWebhookSecret({ configuredSecret: "wh-secret", headerValue: undefined }),
    ).toEqual({ ok: false, status: 401 });
  });

  it("401s when configured but the header doesn't match", () => {
    expect(
      verifyTelegramWebhookSecret({ configuredSecret: "wh-secret", headerValue: "wrong-value" }),
    ).toEqual({ ok: false, status: 401 });
  });

  it("200s when the header exactly matches", () => {
    expect(
      verifyTelegramWebhookSecret({ configuredSecret: "wh-secret", headerValue: "wh-secret" }),
    ).toEqual({ ok: true, status: 200 });
  });
});
