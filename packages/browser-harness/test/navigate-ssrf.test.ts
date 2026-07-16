// Unit tests for the SSRF guard on browser_navigate (issue #216) — the
// browser_harness analog of test/unit/ssrf-guard.test.ts's web_fetch
// coverage. assertPublicUrl itself is exhaustively tested there; these
// tests only assert the wiring: a blocked URL never reaches page.goto(),
// a public URL does, and the allowPrivate option flag (threaded from
// apps/agent's WEB_FETCH_ALLOW_PRIVATE) bypasses the guard.

import { describe, it, expect } from "vitest";
import { buildBrowserTools, type BrowserHarness, type BrowserSession, type BrowserPage } from "../src/index";

const TOOL_EXEC_OPTS = {
  toolCallId: "tc_test",
  messages: [],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  abortSignal: undefined as any,
};

function makeFakeHarness(): { harness: BrowserHarness; gotoCalls: () => string[] } {
  const gotoCalls: string[] = [];
  const page: BrowserPage = {
    async goto(url: string) {
      gotoCalls.push(url);
      return { status: () => 200 };
    },
    url: () => gotoCalls[gotoCalls.length - 1] ?? "about:blank",
    async screenshot() {
      return new Uint8Array();
    },
    locator: () => ({}),
    evaluate: async () => undefined,
    async content() {
      return "";
    },
  };
  const session: BrowserSession = {
    async page() {
      return page;
    },
    async close() {},
    isOpen: () => true,
  };
  const harness: BrowserHarness = {
    async launch() {
      return session;
    },
  };
  return { harness, gotoCalls: () => gotoCalls };
}

describe("browser_navigate SSRF guard", () => {
  it("blocks a cloud-metadata IP and never calls page.goto()", async () => {
    const { harness, gotoCalls } = makeFakeHarness();
    const tools = buildBrowserTools(harness);

    const out = await tools.browser_navigate.execute(
      { url: "http://169.254.169.254/latest/meta-data/" },
      TOOL_EXEC_OPTS,
    );

    expect(out).toContain("Navigate error");
    expect(out).toContain("Blocked URL");
    expect(gotoCalls()).toEqual([]);
  });

  it("blocks a loopback URL", async () => {
    const { harness, gotoCalls } = makeFakeHarness();
    const tools = buildBrowserTools(harness);

    const out = await tools.browser_navigate.execute({ url: "http://127.0.0.1:8080/" }, TOOL_EXEC_OPTS);

    expect(out).toContain("Navigate error");
    expect(gotoCalls()).toEqual([]);
  });

  it("allows a public URL through to page.goto()", async () => {
    const { harness, gotoCalls } = makeFakeHarness();
    const tools = buildBrowserTools(harness);

    const out = await tools.browser_navigate.execute({ url: "https://example.com/path" }, TOOL_EXEC_OPTS);

    expect(out).toBe("Loaded https://example.com/path (HTTP 200)");
    expect(gotoCalls()).toEqual(["https://example.com/path"]);
  });

  it("allowPrivate option bypasses the guard for a loopback target", async () => {
    const { harness, gotoCalls } = makeFakeHarness();
    const tools = buildBrowserTools(harness, null, { allowPrivate: true });

    const out = await tools.browser_navigate.execute({ url: "http://127.0.0.1:8080/health" }, TOOL_EXEC_OPTS);

    expect(out).toBe("Loaded http://127.0.0.1:8080/health (HTTP 200)");
    expect(gotoCalls()).toEqual(["http://127.0.0.1:8080/health"]);
  });

  it("allowPrivate does not bypass the scheme check", async () => {
    const { harness, gotoCalls } = makeFakeHarness();
    const tools = buildBrowserTools(harness, null, { allowPrivate: true });

    const out = await tools.browser_navigate.execute({ url: "file:///etc/passwd" }, TOOL_EXEC_OPTS);

    expect(out).toContain("Navigate error");
    expect(gotoCalls()).toEqual([]);
  });
});
