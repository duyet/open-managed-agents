// Unit tests for resolveCfSandbox / createSandbox — the Cloudflare-side
// sandbox provider resolution seam. Covers: default CloudflareSandbox
// behavior (absent / "cloud" / unknown provider id), the boxrun remote
// adapter (success + missing-config error), and the clear-failure path for
// providers this deployment can't serve (Node-only, and daytona/e2b which
// are cf-compatible in principle but not bundled here yet).

import { describe, it, expect } from "vitest";
import type { Env } from "@duyet/oma-shared";
import { BoxRunSandbox } from "@duyet/oma-sandbox/adapters/boxrun";
import {
  CloudflareSandbox,
  createSandbox,
  resolveCfSandbox,
  SandboxProviderUnavailableError,
} from "./sandbox";

// @cloudflare/sandbox is aliased to test/sandbox-stub.ts in vitest.config.ts
// — getSandbox() there ignores its arguments, so any object satisfies the
// `SANDBOX` binding CloudflareSandbox's constructor reads.
const baseEnv = { SANDBOX: {} } as unknown as Env;

describe("resolveCfSandbox", () => {
  it("defaults to CloudflareSandbox when envConfig is absent", () => {
    const sandbox = resolveCfSandbox(baseEnv, "sess_1", undefined);
    expect(sandbox).toBeInstanceOf(CloudflareSandbox);
  });

  it('defaults to CloudflareSandbox for config.type === "cloud"', () => {
    const sandbox = resolveCfSandbox(baseEnv, "sess_1", { type: "cloud" });
    expect(sandbox).toBeInstanceOf(CloudflareSandbox);
  });

  it("defaults to CloudflareSandbox for an unrecognized sandbox_provider", () => {
    const sandbox = resolveCfSandbox(baseEnv, "sess_1", { sandbox_provider: "made-up" });
    expect(sandbox).toBeInstanceOf(CloudflareSandbox);
  });

  it("resolves boxrun to a real BoxRunSandbox when BOXRUN_URL is set", () => {
    const env = { ...baseEnv, BOXRUN_URL: "http://boxrun:8100/v1/default" } as unknown as Env;
    const sandbox = resolveCfSandbox(env, "sess_1", { sandbox_provider: "boxrun" });
    expect(sandbox).toBeInstanceOf(BoxRunSandbox);
  });

  it("honors legacy config.type when sandbox_provider is absent", () => {
    const env = { ...baseEnv, BOXRUN_URL: "http://boxrun:8100/v1/default" } as unknown as Env;
    const sandbox = resolveCfSandbox(env, "sess_1", { type: "boxrun" });
    expect(sandbox).toBeInstanceOf(BoxRunSandbox);
  });

  it("sandbox_provider takes priority over legacy config.type", () => {
    const env = { ...baseEnv, BOXRUN_URL: "http://boxrun:8100/v1/default" } as unknown as Env;
    const sandbox = resolveCfSandbox(env, "sess_1", {
      sandbox_provider: "boxrun",
      type: "cloud",
    });
    expect(sandbox).toBeInstanceOf(BoxRunSandbox);
  });

  it("throws SandboxProviderUnavailableError for boxrun without BOXRUN_URL configured", () => {
    expect(() => resolveCfSandbox(baseEnv, "sess_1", { sandbox_provider: "boxrun" })).toThrow(
      SandboxProviderUnavailableError,
    );
  });

  it.each(["subprocess", "litebox", "k8s"])(
    "throws SandboxProviderUnavailableError for the Node-only provider %s",
    (type) => {
      expect(() => resolveCfSandbox(baseEnv, "sess_1", { sandbox_provider: type })).toThrow(
        SandboxProviderUnavailableError,
      );
    },
  );

  it.each(["daytona", "e2b"])(
    "throws SandboxProviderUnavailableError for %s (cf-compatible but not bundled here yet)",
    (type) => {
      expect(() => resolveCfSandbox(baseEnv, "sess_1", { sandbox_provider: type })).toThrow(
        SandboxProviderUnavailableError,
      );
    },
  );

  it("error message names the deployment and the offending provider", () => {
    try {
      resolveCfSandbox(baseEnv, "sess_1", { sandbox_provider: "subprocess" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SandboxProviderUnavailableError);
      expect((err as Error).message).toContain("subprocess");
      expect((err as Error).message).toContain("Cloudflare deployment");
    }
  });
});

describe("createSandbox", () => {
  it("delegates to resolveCfSandbox with the given envConfig", () => {
    const env = { ...baseEnv, BOXRUN_URL: "http://boxrun:8100/v1/default" } as unknown as Env;
    const sandbox = createSandbox(env, "sess_1", { sandbox_provider: "boxrun" });
    expect(sandbox).toBeInstanceOf(BoxRunSandbox);
  });

  it("defaults to CloudflareSandbox when envConfig is omitted (back-compat call shape)", () => {
    const sandbox = createSandbox(baseEnv, "sess_1");
    expect(sandbox).toBeInstanceOf(CloudflareSandbox);
  });
});
