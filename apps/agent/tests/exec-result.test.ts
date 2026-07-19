// Unit tests for the pure exec-string helpers shared by the harness sandbox
// bridges. Relocated from flue-sandbox-bridge.test.ts when the Flue harness
// was removed — covers exit-suffix parsing (incl. the lookalike-in-stdout edge
// case and signal terminations) and shell quoting.

import { describe, it, expect } from "vitest";
import { parseExecResult, shellQuote } from "../src/harness/exec-result";

describe("parseExecResult", () => {
  it("returns exit 0 and full stdout when no suffix is present", () => {
    expect(parseExecResult("hello world")).toEqual({
      stdout: "hello world",
      stderr: "",
      exitCode: 0,
    });
  });

  it("parses a trailing [exit N] suffix and strips it", () => {
    expect(parseExecResult("boom\n[exit 1]")).toEqual({
      stdout: "boom",
      stderr: "",
      exitCode: 1,
    });
  });

  it("only strips the ACTUAL trailing suffix, not an [exit N] lookalike in stdout", () => {
    const raw = "log: printed [exit 5] earlier\nmore output\n[exit 2]";
    expect(parseExecResult(raw)).toEqual({
      stdout: "log: printed [exit 5] earlier\nmore output",
      stderr: "",
      exitCode: 2,
    });
  });

  it("keeps [exit N]-like text in stdout when the command actually exited 0", () => {
    // No trailing suffix was appended (exit 0), so the mid-output token must
    // survive untouched and the exit code must read as 0.
    const raw = "the marker [exit 5] is data, not a suffix";
    expect(parseExecResult(raw)).toEqual({
      stdout: "the marker [exit 5] is data, not a suffix",
      stderr: "",
      exitCode: 0,
    });
  });

  it("reports non-zero for a signal termination suffix", () => {
    expect(parseExecResult("killed\n[exit signal=SIGTERM]").exitCode).toBe(1);
  });

  it("recovers the numeric code from the local-subprocess exit= variant", () => {
    expect(parseExecResult("nope\n[exit exit=3]").exitCode).toBe(3);
  });
});

describe("shellQuote", () => {
  it("wraps plain paths in single quotes", () => {
    expect(shellQuote("/workspace/dir")).toBe("'/workspace/dir'");
  });
  it("preserves spaces inside the quotes", () => {
    expect(shellQuote("/a b/c")).toBe("'/a b/c'");
  });
  it("escapes embedded single quotes so a path can't break out", () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
  });
  it("neutralizes shell metacharacters", () => {
    expect(shellQuote("$(rm -rf /)")).toBe("'$(rm -rf /)'");
  });
});
