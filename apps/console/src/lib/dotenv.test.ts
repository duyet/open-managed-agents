import { describe, it, expect } from "vitest";
import { parseDotenv } from "./dotenv";

describe("parseDotenv", () => {
  it("parses simple KEY=value lines", () => {
    expect(parseDotenv("FOO=bar\nBAZ=qux")).toEqual([
      { name: "FOO", value: "bar" },
      { name: "BAZ", value: "qux" },
    ]);
  });

  it("ignores comments and blank lines", () => {
    const text = "# a comment\n\nFOO=bar\n   \n# another\nBAZ=qux\n";
    expect(parseDotenv(text)).toEqual([
      { name: "FOO", value: "bar" },
      { name: "BAZ", value: "qux" },
    ]);
  });

  it("strips the export prefix", () => {
    expect(parseDotenv("export TOKEN=abc123")).toEqual([
      { name: "TOKEN", value: "abc123" },
    ]);
  });

  it("strips surrounding single and double quotes", () => {
    expect(parseDotenv(`A="hello world"\nB='single'`)).toEqual([
      { name: "A", value: "hello world" },
      { name: "B", value: "single" },
    ]);
  });

  it("keeps a # inside a quoted value but strips a trailing inline comment", () => {
    expect(parseDotenv(`A="v#1"\nB=plain # trailing`)).toEqual([
      { name: "A", value: "v#1" },
      { name: "B", value: "plain" },
    ]);
  });

  it("handles CRLF line endings", () => {
    expect(parseDotenv("FOO=bar\r\nBAZ=qux\r\n")).toEqual([
      { name: "FOO", value: "bar" },
      { name: "BAZ", value: "qux" },
    ]);
  });

  it("later keys win on duplicate names", () => {
    expect(parseDotenv("FOO=one\nFOO=two")).toEqual([{ name: "FOO", value: "two" }]);
  });

  it("skips lines with invalid names", () => {
    expect(parseDotenv("1BAD=x\nhas space=y\nGOOD=z")).toEqual([
      { name: "GOOD", value: "z" },
    ]);
  });

  it("allows = inside the value", () => {
    expect(parseDotenv("URL=postgres://u:p@h/db?a=1")).toEqual([
      { name: "URL", value: "postgres://u:p@h/db?a=1" },
    ]);
  });
});
