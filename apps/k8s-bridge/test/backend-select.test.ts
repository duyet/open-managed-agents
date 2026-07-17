import { describe, expect, it } from "vitest";
import { resolveBridgeBackendKind } from "../src/backend";

describe("resolveBridgeBackendKind", () => {
  it("trusts an explicit BRIDGE_BACKEND=openshell without a gateway endpoint", () => {
    const sel = resolveBridgeBackendKind({ BRIDGE_BACKEND: "openshell" });
    expect(sel.kind).toBe("openshell");
    expect(sel.reason).toContain("explicit");
  });

  it("trusts an explicit BRIDGE_BACKEND=k8s even when a gateway is configured", () => {
    const sel = resolveBridgeBackendKind({
      BRIDGE_BACKEND: "k8s",
      OPENSHELL_GATEWAY_ENDPOINT: "gateway:50051",
    });
    expect(sel.kind).toBe("k8s");
    expect(sel.reason).toContain("explicit");
  });

  it("auto-detects openshell when OPENSHELL_GATEWAY_ENDPOINT is set", () => {
    const sel = resolveBridgeBackendKind({ OPENSHELL_GATEWAY_ENDPOINT: "gateway:50051" });
    expect(sel.kind).toBe("openshell");
    expect(sel.reason).toContain("auto-detected");
  });

  it("defaults to k8s when nothing openshell-shaped is configured", () => {
    const sel = resolveBridgeBackendKind({});
    expect(sel.kind).toBe("k8s");
  });

  it("treats an unrecognized BRIDGE_BACKEND value as auto", () => {
    const sel = resolveBridgeBackendKind({
      BRIDGE_BACKEND: "banana",
      OPENSHELL_GATEWAY_ENDPOINT: "gateway:50051",
    });
    expect(sel.kind).toBe("openshell");
  });
});
