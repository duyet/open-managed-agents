// Boot-time guard: main-node refuses to start when PLATFORM_ROOT_SECRET or
// BETTER_AUTH_SECRET is still set to a historical .env.example placeholder
// value (see oma#170 — those values are public, so an install that copied
// them shares its at-rest encryption key / session-signing key with every
// other install that made the same mistake).
//
// The check runs at module-load time, before any HTTP server exists, so it
// can't be exercised via a request like promote-sandbox-file.test.ts does —
// instead this spawns the real entry point (same tsx-subprocess pattern)
// and asserts the process exits instead of coming up.

import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

const REPO_ROOT = resolve(__dirname, "../../..");
const MAIN_NODE_ENTRY = join(REPO_ROOT, "apps/main-node/src/index.ts");
const TSX_BIN = join(REPO_ROOT, "apps/main-node/node_modules/.bin/tsx");

let child: ChildProcess | null = null;
let dataDir: string | null = null;

afterEach(async () => {
  if (child && child.exitCode === null) {
    await new Promise<void>((res) => {
      child!.once("exit", () => res());
      child!.kill("SIGKILL");
    });
  }
  child = null;
  if (dataDir) {
    rmSync(dataDir, { recursive: true, force: true });
    dataDir = null;
  }
});

function runMainNode(
  env: Record<string, string>,
): Promise<{ code: number | null; output: string }> {
  dataDir = mkdtempSync(join(tmpdir(), `oma-test-secret-guard-${randomBytes(4).toString("hex")}-`));
  const dir = dataDir;
  return new Promise((res) => {
    child = spawn(TSX_BIN, [MAIN_NODE_ENTRY], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PORT: "0",
        DATABASE_PATH: join(dir, "oma.db"),
        AUTH_DATABASE_PATH: join(dir, "auth.db"),
        SANDBOX_WORKDIR: join(dir, "sandboxes"),
        MEMORY_BLOB_DIR: join(dir, "memory-blobs"),
        FILES_BLOB_DIR: join(dir, "files-blobs"),
        SESSION_OUTPUTS_DIR: join(dir, "outputs"),
        AUTH_DISABLED: "1",
        NODE_ENV: "test",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (b: Buffer) => (output += b.toString()));
    child.stderr?.on("data", (b: Buffer) => (output += b.toString()));
    child.once("exit", (code) => res({ code, output }));
    // Safety net: if the guard regresses and the process boots instead of
    // exiting, don't hang the test suite — kill it and let the assertion
    // on `code` fail with a clear message instead of a generic timeout.
    setTimeout(() => {
      if (child && child.exitCode === null) child.kill("SIGKILL");
    }, 15_000);
  });
}

describe("main-node boot guard: leaked .env.example placeholder secrets", () => {
  it("refuses to start when PLATFORM_ROOT_SECRET equals the historical leaked value", async () => {
    const { code, output } = await runMainNode({
      PLATFORM_ROOT_SECRET: "H6vnIyNJZU4GhfacFdqzv5YtsAHohl4fWSFvgC5JQTQ=",
      BETTER_AUTH_SECRET: "test-secret-only-for-vitest",
    });
    expect(code).not.toBe(0);
    expect(output).toMatch(/Refusing to start/i);
    expect(output).toContain("PLATFORM_ROOT_SECRET");
  }, 20_000);

  it("refuses to start when BETTER_AUTH_SECRET equals the historical leaked value", async () => {
    const { code, output } = await runMainNode({
      BETTER_AUTH_SECRET: "9523eb599ad517645a7e6783c150a3da2198591d68383b4c2c41573b21e3431d",
    });
    expect(code).not.toBe(0);
    expect(output).toMatch(/Refusing to start/i);
    expect(output).toContain("BETTER_AUTH_SECRET");
  }, 20_000);

  // issue #187: the docs promise PLATFORM_ROOT_SECRET is "required before
  // first boot" (at-rest encryption of vault credentials) and CF's
  // buildServices enforces it — Node must fail closed the same way instead
  // of silently storing credentials in plaintext.
  it("refuses to start when PLATFORM_ROOT_SECRET is unset", async () => {
    const { code, output } = await runMainNode({
      // Empty string overrides any inherited value from the runner env.
      PLATFORM_ROOT_SECRET: "",
      BETTER_AUTH_SECRET: "test-secret-only-for-vitest",
    });
    expect(code).not.toBe(0);
    expect(output).toMatch(/Refusing to start/i);
    expect(output).toContain("PLATFORM_ROOT_SECRET");
    expect(output).toMatch(/at-rest encryption/i);
  }, 20_000);
});
