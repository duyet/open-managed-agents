// Unit tests for classifyCfSandboxProvider — the pure classification the
// Cloudflare deployment uses to decide whether a `sandbox_provider` (or
// legacy `config.type`) resolves to CloudflareSandbox, a remote HTTP
// adapter, or fails clearly because it's Node-only. See
// apps/agent/src/runtime/sandbox.ts's `resolveCfSandbox` for the caller.

import { describe, it, expect } from "vitest";
import { classifyCfSandboxProvider, SYSTEM_PROVIDERS } from "../src/provider-config";

describe("classifyCfSandboxProvider", () => {
  it("defaults to cloudflare when providerId is absent", () => {
    expect(classifyCfSandboxProvider(undefined)).toEqual({ kind: "cloudflare" });
    expect(classifyCfSandboxProvider(null)).toEqual({ kind: "cloudflare" });
    expect(classifyCfSandboxProvider("")).toEqual({ kind: "cloudflare" });
  });

  it('defaults to cloudflare for "cloud"', () => {
    expect(classifyCfSandboxProvider("cloud")).toEqual({ kind: "cloudflare" });
    // case-insensitive, matches main-node's resolveEnvProvider .toLowerCase()
    expect(classifyCfSandboxProvider("Cloud")).toEqual({ kind: "cloudflare" });
  });

  it("falls back to cloudflare for an unrecognized provider id", () => {
    expect(classifyCfSandboxProvider("totally-unknown-provider")).toEqual({ kind: "cloudflare" });
  });

  it.each(["boxrun", "daytona", "e2b"])(
    "classifies remote HTTP-API adapter %s as remote",
    (type) => {
      expect(classifyCfSandboxProvider(type)).toEqual({ kind: "remote", type });
      // case-insensitive
      expect(classifyCfSandboxProvider(type.toUpperCase())).toEqual({ kind: "remote", type });
    },
  );

  it.each(["subprocess", "litebox", "k8s"])(
    "classifies Node-only adapter %s as unavailable",
    (type) => {
      expect(classifyCfSandboxProvider(type)).toEqual({ kind: "unavailable", type });
    },
  );

  it("trims whitespace before classifying", () => {
    expect(classifyCfSandboxProvider("  boxrun  ")).toEqual({ kind: "remote", type: "boxrun" });
  });

  it("SYSTEM_PROVIDERS.cfCompatible matches the documented remote-vs-node-only split", () => {
    const byType = Object.fromEntries(SYSTEM_PROVIDERS.map((p) => [p.type, p.cfCompatible]));
    expect(byType).toEqual({
      subprocess: false,
      litebox: false,
      boxrun: true,
      daytona: true,
      e2b: true,
      k8s: false,
      "k8s-bridge": true,
      cloud: true,
      "docker-compose": false,
      "github-actions": true,
      "remote-agent": true,
    });
  });
});
