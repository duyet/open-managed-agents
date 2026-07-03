import { describe, it, expect } from "vitest";
import {
  checkTrustedProxyGuard,
  extractTrustedProxyIdentity,
  isTrustedProxyAttempt,
  type TrustedProxyGuardConfig,
} from "../src/trusted-proxy";

function baseConfig(overrides: Partial<TrustedProxyGuardConfig> = {}): TrustedProxyGuardConfig {
  return {
    enabled: true,
    userHeader: "x-forwarded-user",
    sharedSecretHeader: "x-trusted-proxy-secret",
    sharedSecret: "correct-horse-battery-staple",
    ...overrides,
  };
}

describe("isTrustedProxyAttempt", () => {
  it("is false when disabled, regardless of headers present", () => {
    const config = baseConfig({ enabled: false });
    const headers = new Headers({ "x-forwarded-user": "alice@example.com" });
    expect(isTrustedProxyAttempt(config, headers)).toBe(false);
  });

  it("is false when enabled but the identity header is absent", () => {
    const config = baseConfig();
    expect(isTrustedProxyAttempt(config, new Headers())).toBe(false);
  });

  it("is false when the identity header is present but blank/whitespace", () => {
    const config = baseConfig();
    const headers = new Headers({ "x-forwarded-user": "   " });
    expect(isTrustedProxyAttempt(config, headers)).toBe(false);
  });

  it("is true when enabled and the identity header carries a value", () => {
    const config = baseConfig();
    const headers = new Headers({ "x-forwarded-user": "alice@example.com" });
    expect(isTrustedProxyAttempt(config, headers)).toBe(true);
  });
});

describe("checkTrustedProxyGuard — fail-closed rules", () => {
  it("fails when disabled even with a matching secret", () => {
    const config = baseConfig({ enabled: false });
    const headers = new Headers({ "x-trusted-proxy-secret": config.sharedSecret! });
    expect(checkTrustedProxyGuard(config, headers)).toBe(false);
  });

  it("fails when enabled but no secret is configured (misconfiguration)", () => {
    const config = baseConfig({ sharedSecret: undefined });
    const headers = new Headers({ "x-trusted-proxy-secret": "anything" });
    expect(checkTrustedProxyGuard(config, headers)).toBe(false);
  });

  it("fails when the request carries no secret header at all", () => {
    const config = baseConfig();
    expect(checkTrustedProxyGuard(config, new Headers())).toBe(false);
  });

  it("fails when the request's secret does not match (spoofing attempt)", () => {
    const config = baseConfig();
    const headers = new Headers({ "x-trusted-proxy-secret": "wrong-secret" });
    expect(checkTrustedProxyGuard(config, headers)).toBe(false);
  });

  it("fails when the request's secret is a different length than expected", () => {
    const config = baseConfig();
    const headers = new Headers({ "x-trusted-proxy-secret": "short" });
    expect(checkTrustedProxyGuard(config, headers)).toBe(false);
  });

  it("passes when enabled, secret configured, and the request's secret matches", () => {
    const config = baseConfig();
    const headers = new Headers({ "x-trusted-proxy-secret": config.sharedSecret! });
    expect(checkTrustedProxyGuard(config, headers)).toBe(true);
  });
});

describe("extractTrustedProxyIdentity", () => {
  it("returns null when the identity header is blank", () => {
    const config = baseConfig();
    expect(extractTrustedProxyIdentity(config, new Headers())).toBeNull();
  });

  it("uses the identity header's value as both subject and email by default", () => {
    const config = baseConfig();
    const headers = new Headers({ "x-forwarded-user": "alice@example.com" });
    expect(extractTrustedProxyIdentity(config, headers)).toEqual({
      subject: "alice@example.com",
      email: "alice@example.com",
      name: "alice",
    });
  });

  it("prefers a separately-configured email header over the identity header", () => {
    const config = baseConfig({ emailHeader: "x-forwarded-email" });
    const headers = new Headers({
      "x-forwarded-user": "alice.login",
      "x-forwarded-email": "alice@example.com",
    });
    expect(extractTrustedProxyIdentity(config, headers)).toEqual({
      subject: "alice.login",
      email: "alice@example.com",
      name: "alice",
    });
  });

  it("falls back to the identity header when the email header is configured but blank", () => {
    const config = baseConfig({ emailHeader: "x-forwarded-email" });
    const headers = new Headers({ "x-forwarded-user": "alice@example.com" });
    expect(extractTrustedProxyIdentity(config, headers)?.email).toBe("alice@example.com");
  });

  it("uses nameHeader when configured", () => {
    const config = baseConfig({ nameHeader: "x-forwarded-name" });
    const headers = new Headers({
      "x-forwarded-user": "alice@example.com",
      "x-forwarded-name": "Alice Example",
    });
    expect(extractTrustedProxyIdentity(config, headers)?.name).toBe("Alice Example");
  });
});
