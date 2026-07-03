// Unit tests for the OMA→Flue sandbox bridge. Pure logic only — a fake
// SandboxExecutor stands in for a real container, so no cluster, no LLM, no
// filesystem. Covers exit-suffix parsing (incl. the lookalike-in-stdout edge
// case and signal terminations), shell quoting, and the fs shims
// (readdir/stat/exists/mkdir/rm) plus the byte read/write fallbacks.

import { describe, it, expect } from "vitest";
import type { SandboxExecutor, ProcessHandle } from "@duyet/oma-sandbox";
import {
  parseExecResult,
  shellQuote,
  createFlueSandboxApi,
} from "../src/harness/flue/sandbox-bridge";

/** Programmable fake OMA sandbox. `handler` maps a command to its raw output. */
class FakeExecutor implements SandboxExecutor {
  calls: string[] = [];
  readFileBytes?: (path: string) => Promise<Uint8Array>;
  writeFileBytes?: (path: string, bytes: Uint8Array) => Promise<string>;
  files = new Map<string, string>();

  constructor(private handler: (cmd: string) => string = () => "") {}

  async exec(command: string): Promise<string> {
    this.calls.push(command);
    return this.handler(command);
  }
  async readFile(path: string): Promise<string> {
    const v = this.files.get(path);
    if (v === undefined) throw new Error(`no file ${path}`);
    return v;
  }
  async writeFile(path: string, content: string): Promise<string> {
    this.files.set(path, content);
    return path;
  }
  // Unused optional members of the port.
  startProcess?(): Promise<ProcessHandle | null>;
}

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

describe("readdir shim", () => {
  it("runs ls -1A with a quoted path and splits lines", async () => {
    const fake = new FakeExecutor(() => "alpha\nbeta\n.hidden");
    const api = createFlueSandboxApi(fake);
    const entries = await api.readdir("/w/dir");
    expect(entries).toEqual(["alpha", "beta", ".hidden"]);
    expect(fake.calls[0]).toBe("ls -1A '/w/dir'");
  });

  it("throws when ls exits non-zero", async () => {
    const fake = new FakeExecutor(() => "ls: no such dir\n[exit 2]");
    const api = createFlueSandboxApi(fake);
    await expect(api.readdir("/missing")).rejects.toThrow(/readdir failed/);
  });
});

describe("stat shim", () => {
  it("reports a directory", async () => {
    const fake = new FakeExecutor(() => "D");
    const api = createFlueSandboxApi(fake);
    const st = await api.stat("/w/d");
    expect(st).toEqual({ isFile: false, isDirectory: true, isSymbolicLink: false });
  });

  it("reports a regular file", async () => {
    const fake = new FakeExecutor(() => "F");
    const api = createFlueSandboxApi(fake);
    const st = await api.stat("/w/f");
    expect(st.isFile).toBe(true);
    expect(st.isDirectory).toBe(false);
  });

  it("marks a symlink-to-directory", async () => {
    const fake = new FakeExecutor(() => "LD");
    const api = createFlueSandboxApi(fake);
    const st = await api.stat("/w/link");
    expect(st.isSymbolicLink).toBe(true);
    expect(st.isDirectory).toBe(true);
  });

  it("throws for a missing path", async () => {
    const fake = new FakeExecutor(() => "MISSING");
    const api = createFlueSandboxApi(fake);
    await expect(api.stat("/nope")).rejects.toThrow(/no such file/);
  });
});

describe("exists shim", () => {
  it("returns true when the probe prints 1", async () => {
    const api = createFlueSandboxApi(new FakeExecutor(() => "1"));
    expect(await api.exists("/w/x")).toBe(true);
  });
  it("returns false when the probe prints 0", async () => {
    const api = createFlueSandboxApi(new FakeExecutor(() => "0"));
    expect(await api.exists("/w/x")).toBe(false);
  });
});

describe("mkdir shim", () => {
  it("uses -p for recursive and quotes the path", async () => {
    const fake = new FakeExecutor(() => "");
    const api = createFlueSandboxApi(fake);
    await api.mkdir("/w/new dir", { recursive: true });
    expect(fake.calls[0]).toBe("mkdir -p '/w/new dir'");
  });
  it("omits -p when not recursive", async () => {
    const fake = new FakeExecutor(() => "");
    const api = createFlueSandboxApi(fake);
    await api.mkdir("/w/x");
    expect(fake.calls[0]).toBe("mkdir '/w/x'");
  });
  it("throws on non-zero exit", async () => {
    const fake = new FakeExecutor(() => "exists\n[exit 1]");
    const api = createFlueSandboxApi(fake);
    await expect(api.mkdir("/w/x")).rejects.toThrow(/mkdir failed/);
  });
});

describe("rm shim", () => {
  it("builds -rf for recursive + force", async () => {
    const fake = new FakeExecutor(() => "");
    const api = createFlueSandboxApi(fake);
    await api.rm("/w/tree", { recursive: true, force: true });
    expect(fake.calls[0]).toBe("rm -rf '/w/tree'");
  });
  it("swallows a non-zero exit when force is set", async () => {
    const fake = new FakeExecutor(() => "rm: missing\n[exit 1]");
    const api = createFlueSandboxApi(fake);
    await expect(api.rm("/gone", { force: true })).resolves.toBeUndefined();
  });
  it("throws a non-zero exit when force is not set", async () => {
    const fake = new FakeExecutor(() => "rm: missing\n[exit 1]");
    const api = createFlueSandboxApi(fake);
    await expect(api.rm("/gone")).rejects.toThrow(/rm failed/);
  });
});

describe("exec option wrapping", () => {
  it("prepends cd for cwd and export for env, all quoted", async () => {
    const fake = new FakeExecutor(() => "ok");
    const api = createFlueSandboxApi(fake);
    await api.exec("echo hi", { cwd: "/w d", env: { FOO: "b ar" } });
    expect(fake.calls[0]).toBe("export FOO='b ar'; cd '/w d' && echo hi");
  });
  it("leaves the command untouched with no cwd/env", async () => {
    const fake = new FakeExecutor(() => "ok");
    const api = createFlueSandboxApi(fake);
    await api.exec("echo hi");
    expect(fake.calls[0]).toBe("echo hi");
  });
});

describe("byte read/write fallbacks", () => {
  it("readFileBuffer falls back to a UTF-8 encode of readFile", async () => {
    const fake = new FakeExecutor();
    fake.files.set("/w/t.txt", "héllo");
    const api = createFlueSandboxApi(fake);
    const buf = await api.readFileBuffer("/w/t.txt");
    expect(new TextDecoder().decode(buf)).toBe("héllo");
  });

  it("readFileBuffer uses readFileBytes when the port provides it", async () => {
    const fake = new FakeExecutor();
    const bytes = new Uint8Array([1, 2, 3]);
    fake.readFileBytes = async () => bytes;
    const api = createFlueSandboxApi(fake);
    expect(await api.readFileBuffer("/w/bin")).toBe(bytes);
  });

  it("writeFile prefers writeFileBytes for a Uint8Array", async () => {
    const fake = new FakeExecutor();
    let received: Uint8Array | null = null;
    fake.writeFileBytes = async (_p, b) => {
      received = b;
      return _p;
    };
    const api = createFlueSandboxApi(fake);
    const bytes = new Uint8Array([9, 8, 7]);
    await api.writeFile("/w/bin", bytes);
    expect(received).toBe(bytes);
  });

  it("writeFile routes a string to the string writer", async () => {
    const fake = new FakeExecutor();
    const api = createFlueSandboxApi(fake);
    await api.writeFile("/w/s.txt", "data");
    expect(fake.files.get("/w/s.txt")).toBe("data");
  });
});
