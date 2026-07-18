/**
 * Best-effort version detection for detected ACP agents.
 *
 * `detectAll()` (from @duyet/oma-acp-runtime) tells us WHICH agents are
 * present on $PATH; this layer adds the third detection signal the runtime
 * heartbeat reports — the agent's self-reported VERSION — so the Console can
 * show "claude-acp (claude v1.2.3)" and users can tell stale installs apart.
 *
 * Design constraints (mirrors the rest of bridge detection):
 *   - **Fast**: all probes run in parallel with a short per-probe timeout.
 *   - **Fail-soft**: a probe that errors, times out, or prints nothing
 *     version-shaped yields `undefined` — never throws, never blocks the
 *     heartbeat. A missing version just means "unknown", not "absent".
 *   - **Safe**: only ever spawns a well-known agent binary with a single
 *     `--version` argument. Never executes a discovered file, never shells
 *     out with user-controlled args.
 *
 * `exec` is injected (defaults to a `spawn` wrapper) so the parsing +
 * fan-out logic is unit-testable without spawning real processes — same
 * convention as spawn-cwd.ts's `runGit`.
 */

import { spawn } from "node:child_process";

/** Minimal, injectable subprocess runner. Resolves with the exit code and
 *  captured stdout+stderr; never rejects (errors surface as `code !== 0`). */
export type VersionExec = (
  cmd: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ code: number | null; out: string }>;

/** Just enough of a KnownAgentEntry for version probing — keeps this module
 *  decoupled from the acp-runtime registry types. */
export interface VersionProbeTarget {
  id: string;
  /** The binary reported to the platform as this agent's `binary`. */
  binary: string;
  /** When this agent is an ACP wrapper, the upstream binary it wraps
   *  (e.g. claude-acp → `claude`). We prefer probing the upstream because
   *  its `--version` is the one users recognise; the thin wrapper's own
   *  version is rarely meaningful. */
  wraps?: string;
}

/** Package-manager launchers whose `--version` reports the launcher, not the
 *  agent — probing them would be misleading, so we skip (report unknown). */
const OPAQUE_LAUNCHERS = new Set(["npx", "uvx", "npm", "uv", "pnpm", "bunx"]);

const DEFAULT_TIMEOUT_MS = 2_000;

const defaultExec: VersionExec = (cmd, args, timeoutMs) =>
  new Promise((resolve) => {
    let out = "";
    let settled = false;
    const done = (code: number | null) => {
      if (settled) return;
      settled = true;
      resolve({ code, out });
    };
    let p: ReturnType<typeof spawn>;
    try {
      p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      return done(null);
    }
    const timer = setTimeout(() => {
      try { p.kill("SIGKILL"); } catch { /* already gone */ }
      done(null);
    }, timeoutMs);
    p.stdout?.on("data", (b) => { out += b.toString(); });
    p.stderr?.on("data", (b) => { out += b.toString(); });
    p.once("error", () => { clearTimeout(timer); done(null); });
    p.once("close", (code) => { clearTimeout(timer); done(code); });
  });

/**
 * Extract the first version-looking token from `--version` output.
 * Matches `1.2.3`, `v0.7`, `2024.1.0-beta.1`, etc. Returns `undefined`
 * when nothing version-shaped is present (fail-soft).
 */
export function parseVersion(raw: string): string | undefined {
  const m = raw.match(/\bv?(\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.]+)?)\b/);
  return m ? m[1] : undefined;
}

/** Probe a single target's version. Fail-soft → `undefined`. */
export async function probeAgentVersion(
  target: VersionProbeTarget,
  exec: VersionExec = defaultExec,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string | undefined> {
  const cmd = target.wraps ?? target.binary;
  if (!cmd || OPAQUE_LAUNCHERS.has(cmd)) return undefined;
  try {
    const { out } = await exec(cmd, ["--version"], timeoutMs);
    return parseVersion(out);
  } catch {
    return undefined;
  }
}

/**
 * Attach a best-effort `version` to each detected agent, probing all
 * targets in parallel. Entries whose version can't be determined keep
 * their other fields and simply omit `version`.
 */
export async function attachAgentVersions<T extends VersionProbeTarget>(
  targets: T[],
  exec: VersionExec = defaultExec,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Array<T & { version?: string }>> {
  return Promise.all(
    targets.map(async (t) => {
      const version = await probeAgentVersion(t, exec, timeoutMs);
      return version ? { ...t, version } : { ...t };
    }),
  );
}
