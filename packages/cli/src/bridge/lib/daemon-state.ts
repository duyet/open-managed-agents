/**
 * Daemon runtime-state file — a small JSON snapshot the daemon writes so
 * out-of-process commands (`oma bridge status`) can report whether the
 * daemon is actually connected, how fresh its last heartbeat is, and how
 * long it's been up, without having to parse `launchctl` / `systemctl`
 * output.
 *
 * This is observability-only. Nothing in the session/ACP path depends on
 * it, and every write is best-effort — a failed write must never take the
 * daemon down. The file lives next to `daemon.pid` under the profile-aware
 * configDir so profile isolation comes for free.
 *
 * The pure helpers (`formatAge`, `summarizeState`) carry no Node builtins
 * and are unit-tested directly; the fs + `process.kill` bits are exercised
 * by the e2e lifecycle test.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./platform.js";

export interface DaemonState {
  /** Daemon process id (matches daemon.pid). */
  pid: number;
  /** When the daemon process started (unix ms). */
  startedAt: number;
  /** Last successful WS attach (unix ms), or null if never attached. */
  attachedAt: number | null;
  /** Last heartbeat ping sent to the server (unix ms), or null. */
  lastHeartbeatAt: number | null;
  /** Whether the WS is currently believed to be open. */
  connected: boolean;
  /** How many tenants this daemon is authorized for (for display only). */
  tenantCount: number;
}

function statePath(): string {
  return join(paths().configDir, "daemon-state.json");
}

/** Overwrite the daemon-state file with a full snapshot. Best-effort. */
export function writeDaemonState(state: DaemonState): void {
  try {
    writeFileSync(statePath(), JSON.stringify(state), "utf-8");
  } catch {
    /* observability only — never fatal */
  }
}

/** Read the daemon-state snapshot, or null if missing/unreadable/corrupt. */
export function readDaemonState(): DaemonState | null {
  let text: string;
  try {
    text = readFileSync(statePath(), "utf-8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as Partial<DaemonState>;
    if (typeof parsed.pid !== "number" || typeof parsed.startedAt !== "number") {
      return null;
    }
    return {
      pid: parsed.pid,
      startedAt: parsed.startedAt,
      attachedAt: typeof parsed.attachedAt === "number" ? parsed.attachedAt : null,
      lastHeartbeatAt:
        typeof parsed.lastHeartbeatAt === "number" ? parsed.lastHeartbeatAt : null,
      connected: parsed.connected === true,
      tenantCount: typeof parsed.tenantCount === "number" ? parsed.tenantCount : 0,
    };
  } catch {
    return null;
  }
}

/** Best-effort "is this pid a live process". Returns false on any error. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // signal 0 performs error checking without actually sending a signal:
    // throws ESRCH if the process is gone, EPERM if it exists but we can't
    // signal it (still alive → true).
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Render an elapsed duration (ms) as a compact human string:
 * "just now", "8s ago", "3m ago", "2h ago", "4d ago". Negative or
 * NaN inputs render as "unknown" so callers don't have to guard.
 */
export function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  const s = Math.floor(ms / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
