import { describe, expect, it } from "vitest";
import {
  renderProgressBlocks,
  renderProgressText,
  renderFinalResponseBlocks,
  renderFinalResponseText,
  renderErrorBlocks,
  truncate,
  SECTION_TEXT_LIMIT,
} from "./blocks";

describe("truncate", () => {
  it("returns not-truncated for short text", () => {
    const r = truncate("hello world", 100);
    expect(r.truncated).toBe(false);
    expect(r.text).toBe("hello world");
  });

  it("cuts on a word boundary and appends an ellipsis", () => {
    const r = truncate("the quick brown fox jumps", 12);
    expect(r.truncated).toBe(true);
    expect(r.text.endsWith("…")).toBe(true);
    expect(r.text).not.toContain("jumps");
  });
});

describe("renderProgressBlocks", () => {
  it("shows a spinner while working and the headline", () => {
    const blocks = renderProgressBlocks({ headline: "Investigating latency", steps: [] });
    expect(blocks).toHaveLength(1);
    const text = JSON.stringify(blocks);
    expect(text).toContain("hourglass_flowing_sand");
    expect(text).toContain("Investigating latency");
  });

  it("renders per-step icons for running/done/failed", () => {
    const blocks = renderProgressBlocks({
      headline: "Working",
      steps: [
        { label: "Check Datadog", state: "done" },
        { label: "Search GitHub", state: "running" },
        { label: "PagerDuty", state: "failed" },
      ],
    });
    const text = JSON.stringify(blocks);
    expect(text).toContain("white_check_mark");
    expect(text).toContain("hourglass");
    expect(text).toContain(":x:");
    expect(text).toContain("Check Datadog");
  });

  it("drops the spinner when done", () => {
    const blocks = renderProgressBlocks({ headline: "Done", steps: [], done: true });
    const first = blocks[0] as { text: { text: string } };
    expect(first.text.text).not.toContain("hourglass");
  });
});

describe("renderProgressText", () => {
  it("summarizes completed step count", () => {
    const text = renderProgressText({
      headline: "Working",
      steps: [
        { label: "a", state: "done" },
        { label: "b", state: "running" },
      ],
    });
    expect(text).toBe("Working (1/2 steps)");
  });
});

describe("renderFinalResponseBlocks", () => {
  it("includes a header, divider, and the body", () => {
    const blocks = renderFinalResponseBlocks({ agentName: "Reviewer", body: "All good." });
    const text = JSON.stringify(blocks);
    expect(text).toContain("Reviewer");
    expect(text).toContain("divider");
    expect(text).toContain("All good.");
  });

  it("truncates long bodies and links to the console when a url is given", () => {
    const long = "x".repeat(SECTION_TEXT_LIMIT + 500);
    const blocks = renderFinalResponseBlocks({ body: long, sessionUrl: "https://c/sess_1" });
    const text = JSON.stringify(blocks);
    expect(text).toContain("truncated");
    expect(text).toContain("https://c/sess_1");
  });

  it("adds a console link without truncation when body is short", () => {
    const blocks = renderFinalResponseBlocks({ body: "short", sessionUrl: "https://c/sess_2" });
    const text = JSON.stringify(blocks);
    expect(text).toContain("Open in Console");
    expect(text).not.toContain("truncated");
  });
});

describe("renderFinalResponseText", () => {
  it("falls back to a placeholder for empty bodies", () => {
    expect(renderFinalResponseText({ body: "   " })).toBe("(no response)");
  });
});

describe("renderErrorBlocks", () => {
  it("renders a friendly warning without leaking a raw stack", () => {
    const blocks = renderErrorBlocks("rate_limited", "https://c/sess_9");
    const text = JSON.stringify(blocks);
    expect(text).toContain("warning");
    expect(text).toContain("couldn't finish");
    expect(text).toContain("rate_limited");
    expect(text).toContain("https://c/sess_9");
  });
});
