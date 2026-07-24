import { describe, it, expect } from "vitest";
import browserVmHostRoutes from "./browser-vm-host";

describe("browser-vm host page", () => {
  it("serves the host page with cross-origin isolation headers", async () => {
    const res = await browserVmHostRoutes.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(res.headers.get("Cross-Origin-Embedder-Policy")).toBe("require-corp");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("embeds the registration + relay contract the platform depends on", async () => {
    const res = await browserVmHostRoutes.request("/");
    const html = await res.text();
    // Pairing: exchanges the one-time code with the browser-vm kind so
    // pickOnlineRuntimeId's kind filter can find this runtime.
    expect(html).toContain("/agents/runtime/exchange");
    expect(html).toContain('kind: "browser-vm"');
    // Relay: attaches via access_token query param (browser WS can't set
    // an Authorization header) and speaks sandbox.op / sandbox.result.
    expect(html).toContain("/agents/runtime/_attach?access_token=");
    expect(html).toContain("sandbox.op");
    expect(html).toContain("sandbox.result");
    // Ops served against the engine seam.
    for (const op of ["exec", "readFile", "writeFile", "setEnvVars", "destroy"]) {
      expect(html).toContain(`"${op}"`);
    }
  });
});
