/**
 * Framework-free helpers for adapting OMA's `SandboxExecutor.exec()` output —
 * shared by the harness sandbox bridges. Formerly lived in
 * `./flue/sandbox-bridge.ts`; relocated here when the Flue harness was removed
 * so the surviving `claude-agent-sdk` bridge keeps them without depending on
 * `@flue/runtime`.
 *
 * OMA's `exec(cmd)` returns combined stdout+stderr as a single string with a
 * trailing `\n[exit N]` suffix appended ONLY when the command exited non-zero
 * (the @cloudflare/sandbox convention, matched by the e2b/daytona/litebox/
 * local-subprocess adapters). These two pure functions recover a structured
 * result and safely shell-quote paths.
 */

/** Structured shell result recovered from an OMA exec string. */
export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

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
 * Parse an OMA `exec()` result string into a {@link ShellResult}.
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
