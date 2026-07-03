/**
 * Sandbox bridge — adapts an OMA {@link SandboxExecutor} into Flue's
 * {@link SandboxApi}, so a Flue agent can run its shell + filesystem tools
 * inside whatever sandbox OMA already provisioned for the session.
 *
 * OMA's port is intentionally thin: `exec(cmd)` returns the combined
 * stdout+stderr as a single string with a trailing `\n[exit N]` suffix
 * appended ONLY when the command exited non-zero (the @cloudflare/sandbox
 * convention, matched by the e2b/daytona/litebox/local-subprocess adapters).
 * Flue instead wants a structured {@link ShellResult} `{stdout, stderr,
 * exitCode}` plus a handful of filesystem primitives (`stat`, `readdir`,
 * `exists`, `mkdir`, `rm`) that OMA's port doesn't expose directly.
 *
 * This module owns two pure concerns that are unit-tested in isolation:
 *   1. {@link parseExecResult} — recover `{stdout, exitCode}` from the OMA
 *      exec string, stripping ONLY the genuine trailing `[exit N]` suffix
 *      (never an `[exit N]`-looking token that legitimately appears earlier
 *      in the output).
 *   2. {@link shellQuote} — single-quote a path so spaces / globs / quotes /
 *      `$`… in a path can't break out of the shimmed shell command.
 *
 * The filesystem shims route through `exec(...)` with `ls -1A`, `test`,
 * `mkdir -p`, `rm -rf`; text reads/writes route to the OMA port's own
 * `readFile`/`writeFile`, and binary reads/writes prefer the optional
 * `readFileBytes`/`writeFileBytes` when the underlying adapter provides them.
 */

import type { SandboxExecutor } from "@duyet/oma-sandbox";
import type { SandboxApi, FileStat, ShellResult } from "@flue/runtime";

/**
 * Single-quote a value for safe interpolation into a `/bin/sh -c` command.
 * Wraps in single quotes and escapes any embedded single quote via the
 * classic `'\''` sequence, so a path such as `a'b c$(x)` can never terminate
 * the quoting or trigger expansion.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Trailing exit-code suffix produced by the OMA sandbox adapters. Anchored to
 * the END of the string via `$` so a `[exit 5]`-looking token that appears
 * earlier in real command output is never mistaken for the suffix. The capture
 * group is deliberately permissive (`[^\]]+`) to also tolerate the
 * local-subprocess variants `[exit exit=1]` and `[exit signal=SIGTERM]`; the
 * numeric code (or a non-zero fallback for signals) is recovered separately.
 */
const EXIT_SUFFIX = /\n\[exit ([^\]]+)\]$/;

/**
 * Parse an OMA `exec()` result string into a Flue {@link ShellResult}.
 *
 * OMA merges stdout+stderr upstream and we cannot reliably re-split them, so
 * the combined text (minus the suffix) lands in `stdout` and `stderr` is left
 * empty — the honest mapping given the source shape. `exitCode` is 0 unless a
 * genuine trailing `[exit N]` suffix is present.
 */
export function parseExecResult(raw: string): ShellResult {
  const match = raw.match(EXIT_SUFFIX);
  if (!match) {
    // No suffix → the command exited 0 (adapters only append on non-zero).
    return { stdout: raw, stderr: "", exitCode: 0 };
  }
  const token = match[1];
  const digits = token.match(/(\d+)/);
  // Numeric `[exit N]` → N. A signal termination (`signal=SIGTERM`) or any
  // non-numeric token still means failure → report a non-zero code so callers
  // never read a signalled command as success.
  const exitCode = digits ? Number(digits[1]) : 1;
  const stdout = raw.slice(0, raw.length - match[0].length);
  return { stdout, stderr: "", exitCode };
}

/** Options Flue may pass to {@link SandboxApi.exec}. */
type FlueExecOptions = {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
};

/**
 * Wrap a bare command so it honours Flue's `cwd` / `env` options against an
 * OMA port whose `exec(cmd, timeout?)` has no such parameters. `cd` and inline
 * `KEY=value` assignments are prepended with proper shell-quoting. Returns the
 * command unchanged when neither option is set.
 */
function wrapCommand(command: string, options?: FlueExecOptions): string {
  const parts: string[] = [];
  if (options?.env) {
    for (const [key, value] of Object.entries(options.env)) {
      parts.push(`${key}=${shellQuote(value)}`);
    }
  }
  const envPrefix = parts.length > 0 ? `export ${parts.join(" ")}; ` : "";
  const cdPrefix = options?.cwd ? `cd ${shellQuote(options.cwd)} && ` : "";
  if (!envPrefix && !cdPrefix) return command;
  return `${envPrefix}${cdPrefix}${command}`;
}

/**
 * Adapter implementing Flue's {@link SandboxApi} on top of an OMA
 * {@link SandboxExecutor}. Constructed via {@link createFlueSandboxApi}.
 */
export class OmaFlueSandboxApi implements SandboxApi {
  readonly #exec: SandboxExecutor;

  constructor(executor: SandboxExecutor) {
    this.#exec = executor;
  }

  /** Run a command and surface OMA's combined output as a structured result. */
  async exec(command: string, options?: FlueExecOptions): Promise<ShellResult> {
    const wrapped = wrapCommand(command, options);
    const raw = await this.#exec.exec(wrapped, options?.timeoutMs);
    return parseExecResult(raw);
  }

  readFile(path: string): Promise<string> {
    return this.#exec.readFile(path);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    if (this.#exec.readFileBytes) {
      return this.#exec.readFileBytes(path);
    }
    // Fall back to the text read + UTF-8 encode. Callers that need byte-exact
    // binary reads should back this with an adapter that implements
    // readFileBytes; UTF-8 round-tripping is lossy for non-text bytes.
    const text = await this.#exec.readFile(path);
    return new TextEncoder().encode(text);
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    if (typeof content === "string") {
      await this.#exec.writeFile(path, content);
      return;
    }
    if (this.#exec.writeFileBytes) {
      await this.#exec.writeFileBytes(path, content);
      return;
    }
    // No byte-safe writer on this adapter — best-effort decode. Same caveat as
    // readFileBuffer: prefer an adapter exposing writeFileBytes for binaries.
    await this.#exec.writeFile(path, new TextDecoder().decode(content));
  }

  async stat(path: string): Promise<FileStat> {
    // One round-trip classifies the entry. `-e` first so a missing path is a
    // clean throw (Flue's contract: stat throws when the path doesn't exist).
    const q = shellQuote(path);
    const script =
      `if [ ! -e ${q} ] && [ ! -L ${q} ]; then echo MISSING; exit 0; fi; ` +
      `if [ -L ${q} ]; then printf L; fi; ` +
      `if [ -d ${q} ]; then printf D; elif [ -f ${q} ]; then printf F; else printf O; fi`;
    const { stdout } = await this.exec(script);
    const flags = stdout.trim();
    if (flags === "MISSING") {
      throw new Error(`stat: no such file or directory: ${path}`);
    }
    // Do not fabricate size / mtime — OMA's port doesn't expose them, and Flue
    // requires adapters to omit metadata they can't observe.
    return {
      isFile: flags.includes("F"),
      isDirectory: flags.includes("D"),
      isSymbolicLink: flags.includes("L"),
    };
  }

  async readdir(path: string): Promise<string[]> {
    const { stdout, stderr, exitCode } = await this.exec(`ls -1A ${shellQuote(path)}`);
    if (exitCode !== 0) {
      throw new Error(`readdir failed for ${path}: ${stderr || stdout}`.trim());
    }
    return stdout.split("\n").filter((line) => line.length > 0);
  }

  async exists(path: string): Promise<boolean> {
    // Never throws (Flue contract). `test -e` covers files+dirs; `-L` also
    // reports a dangling symlink as present, matching node's fs.exists.
    const q = shellQuote(path);
    const { stdout } = await this.exec(
      `if [ -e ${q} ] || [ -L ${q} ]; then echo 1; else echo 0; fi`,
    );
    return stdout.trim() === "1";
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const flag = options?.recursive ? "-p " : "";
    const { stdout, stderr, exitCode } = await this.exec(
      `mkdir ${flag}${shellQuote(path)}`,
    );
    if (exitCode !== 0) {
      throw new Error(`mkdir failed for ${path}: ${stderr || stdout}`.trim());
    }
  }

  async rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean },
  ): Promise<void> {
    const flags: string[] = [];
    if (options?.recursive) flags.push("r");
    if (options?.force) flags.push("f");
    const flagStr = flags.length > 0 ? `-${flags.join("")} ` : "";
    const { stdout, stderr, exitCode } = await this.exec(
      `rm ${flagStr}${shellQuote(path)}`,
    );
    // With `force`, a missing path is not an error (rm -f swallows it). Without
    // it, a non-zero exit is a genuine failure worth surfacing.
    if (exitCode !== 0 && !options?.force) {
      throw new Error(`rm failed for ${path}: ${stderr || stdout}`.trim());
    }
  }
}

/**
 * Build a Flue {@link SandboxApi} from an OMA {@link SandboxExecutor}. Pass the
 * result to `createSandboxSessionEnv(api, cwd)` to obtain the `SessionEnv` a
 * Flue agent runs against.
 */
export function createFlueSandboxApi(executor: SandboxExecutor): SandboxApi {
  return new OmaFlueSandboxApi(executor);
}
