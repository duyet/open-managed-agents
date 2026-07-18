import { describe, expect, it } from "vitest";
import { generateSessionTitle, heuristicTitle, shouldGenerateSessionTitle } from "./session-title";
import type { LanguageModel } from "ai";

describe("heuristicTitle", () => {
  it("keeps the first ~6 words", () => {
    expect(heuristicTitle("Help me refactor the authentication middleware to use JWT tokens")).toBe(
      "Help me refactor the authentication middleware",
    );
  });

  it("collapses newlines and repeated whitespace", () => {
    expect(heuristicTitle("Fix   the\nbug\n\nin   checkout flow please")).toBe("Fix the bug in checkout flow");
  });

  it("returns the whole message when shorter than the word cap", () => {
    expect(heuristicTitle("Hello there")).toBe("Hello there");
  });

  it("truncates to 60 chars", () => {
    const longWords = "supercalifragilisticexpialidocious".repeat(3) + " word2 word3 word4 word5 word6";
    const title = heuristicTitle(longWords);
    expect(title.length).toBeLessThanOrEqual(60);
  });

  it("falls back to a generic title for empty/whitespace-only input", () => {
    expect(heuristicTitle("   \n\t  ")).toBe("New session");
    expect(heuristicTitle("")).toBe("New session");
  });
});

describe("generateSessionTitle", () => {
  const fakeModel = {} as LanguageModel;

  it("uses the heuristic fallback when no aux model is configured", async () => {
    const title = await generateSessionTitle({
      text: "Please help me deploy the staging environment today",
      auxModel: null,
    });
    expect(title).toBe(heuristicTitle("Please help me deploy the staging environment today"));
  });

  it("uses the aux model's summary when it succeeds", async () => {
    const title = await generateSessionTitle({
      text: "Investigate why the nightly cron job keeps failing on staging",
      auxModel: fakeModel,
      generateTextFn: (async () => ({ text: "Debug nightly cron failure" })) as never,
    });
    expect(title).toBe("Debug nightly cron failure");
  });

  it("strips wrapping quotes from the aux model's response", async () => {
    const title = await generateSessionTitle({
      text: "Investigate cron failure",
      auxModel: fakeModel,
      generateTextFn: (async () => ({ text: '"Debug nightly cron failure"' })) as never,
    });
    expect(title).toBe("Debug nightly cron failure");
  });

  it("falls back to the heuristic when the aux model call throws", async () => {
    const text = "Set up CI pipeline for the new microservice";
    const title = await generateSessionTitle({
      text,
      auxModel: fakeModel,
      generateTextFn: (async () => {
        throw new Error("model unavailable");
      }) as never,
    });
    expect(title).toBe(heuristicTitle(text));
  });

  it("falls back to the heuristic when the aux model returns an empty string", async () => {
    const text = "Write unit tests for the payment webhook handler";
    const title = await generateSessionTitle({
      text,
      auxModel: fakeModel,
      generateTextFn: (async () => ({ text: "   " })) as never,
    });
    expect(title).toBe(heuristicTitle(text));
  });
});

describe("shouldGenerateSessionTitle", () => {
  it("runs on the first real user message of a fresh session", () => {
    expect(
      shouldGenerateSessionTitle({ currentTitle: "", skipAppend: false, text: "Help me ship a feature" }),
    ).toBe(true);
  });

  it("skips once a title is already set — the once-only guard", () => {
    expect(
      shouldGenerateSessionTitle({ currentTitle: "Ship a feature", skipAppend: false, text: "Another message" }),
    ).toBe(false);
  });

  it("skips synthetic-empty-message resumes (tool confirmation / custom tool result continuations)", () => {
    expect(shouldGenerateSessionTitle({ currentTitle: "", skipAppend: true, text: "" })).toBe(false);
    // Even if some text were present, a skipAppend resume is never the
    // user's original first message and must not overwrite the guard.
    expect(shouldGenerateSessionTitle({ currentTitle: "", skipAppend: true, text: "some resumed text" })).toBe(
      false,
    );
  });

  it("skips a message with no extractable text", () => {
    expect(shouldGenerateSessionTitle({ currentTitle: "", skipAppend: false, text: "   " })).toBe(false);
    expect(shouldGenerateSessionTitle({ currentTitle: "", skipAppend: false, text: "" })).toBe(false);
  });
});
