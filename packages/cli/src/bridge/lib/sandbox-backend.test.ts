// Backend-selection tests for the bridge daemon. Pure function — no process
// env, no sockets. Mirrors apps/k8s-bridge's resolveBridgeBackendKind tests.

import { describe, it, expect } from "vitest";
import { resolveSandboxBackend } from "./sandbox-backend.js";

describe("resolveSandboxBackend", () => {
  it("defaults to local when nothing is configured", () => {
    const s = resolveSandboxBackend({}, {});
    expect(s.kind).toBe("local");
    expect(s.openshell).toBeUndefined();
    expect(s.reason).toMatch(/no OpenShell/i);
  });

  it("--backend openshell is trusted and carries endpoint from --openshell-url", () => {
    const s = resolveSandboxBackend(
      { backend: "openshell", openshellUrl: "10.0.0.5:8080" },
      {},
    );
    expect(s.kind).toBe("openshell");
    expect(s.openshell?.endpoint).toBe("10.0.0.5:8080");
    expect(s.reason).toMatch(/--backend=openshell \(explicit\)/);
  });

  it("--backend local wins even when an OpenShell endpoint is present", () => {
    const s = resolveSandboxBackend(
      { backend: "local" },
      { OMA_OPENSHELL_URL: "127.0.0.1:8080" },
    );
    expect(s.kind).toBe("local");
    expect(s.reason).toMatch(/--backend=local \(explicit\)/);
  });

  it("treats 'subprocess' as an alias for local", () => {
    const s = resolveSandboxBackend({ backend: "subprocess" }, {});
    expect(s.kind).toBe("local");
  });

  it("OMA_BRIDGE_BACKEND=openshell selects openshell from env", () => {
    const s = resolveSandboxBackend(
      {},
      { OMA_BRIDGE_BACKEND: "openshell", OMA_OPENSHELL_URL: "gw:9090" },
    );
    expect(s.kind).toBe("openshell");
    expect(s.openshell?.endpoint).toBe("gw:9090");
    expect(s.reason).toMatch(/OMA_BRIDGE_BACKEND=openshell/);
  });

  it("the --backend flag beats OMA_BRIDGE_BACKEND", () => {
    const s = resolveSandboxBackend(
      { backend: "local" },
      { OMA_BRIDGE_BACKEND: "openshell", OMA_OPENSHELL_URL: "gw:9090" },
    );
    expect(s.kind).toBe("local");
    expect(s.reason).toMatch(/^--backend=/);
  });

  it("auto-detects openshell from OMA_OPENSHELL_URL with no explicit backend", () => {
    const s = resolveSandboxBackend({}, { OMA_OPENSHELL_URL: "gw:9090" });
    expect(s.kind).toBe("openshell");
    expect(s.reason).toMatch(/auto-detected: OpenShell endpoint gw:9090/);
  });

  it("auto-detects openshell from the adapter's OPENSHELL_GATEWAY_ENDPOINT too", () => {
    const s = resolveSandboxBackend({}, { OPENSHELL_GATEWAY_ENDPOINT: "gw:1234" });
    expect(s.kind).toBe("openshell");
    expect(s.openshell?.endpoint).toBe("gw:1234");
  });

  it("prefers OMA_OPENSHELL_URL over OPENSHELL_GATEWAY_ENDPOINT", () => {
    const s = resolveSandboxBackend(
      {},
      { OMA_OPENSHELL_URL: "a:1", OPENSHELL_GATEWAY_ENDPOINT: "b:2" },
    );
    expect(s.openshell?.endpoint).toBe("a:1");
  });

  it("carries token + image from OMA_OPENSHELL_* env into the config", () => {
    const s = resolveSandboxBackend(
      { backend: "openshell", openshellUrl: "gw:8080" },
      { OMA_OPENSHELL_TOKEN: "tok", OMA_OPENSHELL_IMAGE: "img:1" },
    );
    expect(s.openshell).toMatchObject({ token: "tok", image: "img:1" });
  });

  it("falls back to the adapter's OPENSHELL_TOKEN / OPENSHELL_IMAGE names", () => {
    const s = resolveSandboxBackend(
      { backend: "openshell", openshellUrl: "gw:8080" },
      { OPENSHELL_TOKEN: "tok2", OPENSHELL_IMAGE: "img:2" },
    );
    expect(s.openshell).toMatchObject({ token: "tok2", image: "img:2" });
  });

  it("an unrecognised explicit backend fails safe to local with a reason", () => {
    const s = resolveSandboxBackend({ backend: "wat" }, {});
    expect(s.kind).toBe("local");
    expect(s.reason).toMatch(/unrecognised/);
  });
});
