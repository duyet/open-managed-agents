/**
 * `oma bridge {start,stop,restart}` — control the installed daemon service.
 *
 * The daemon normally runs under launchd / systemd / Task Scheduler (set up by
 * `oma bridge setup`). These verbs are the missing "just turn it back on"
 * controls — previously the only ways to influence a running daemon were the
 * internal `bridge daemon` (foreground) or a full re-`setup`. They dispatch to
 * the platform's service manager via the service-manager façade.
 */

import { lifecycle, detectServiceKind, type LifecycleAction } from "../lib/service-manager.js";
import { readCreds } from "../lib/config.js";
import { paths } from "../lib/platform.js";
import { printBanner, log, c } from "../lib/style.js";
import { PKG_VERSION } from "../lib/version.js";
import { readDaemonState, isPidAlive, formatAge } from "../lib/daemon-state.js";

const PAST: Record<LifecycleAction, string> = {
  start: "started",
  stop: "stopped",
  restart: "restarted",
};

export async function runControl(action: LifecycleAction): Promise<void> {
  printBanner(action, PKG_VERSION);
  const p = paths();

  // Not paired yet → start/restart have nothing to run; nudge to setup.
  const creds = await readCreds();
  if (!creds && action !== "stop") {
    log.warn("not set up — run `oma bridge setup` to register this machine first");
    log.hint(`looked for ${p.credsFile}`);
    process.exit(1);
  }

  const res = await lifecycle(action);
  if (!res.ok) {
    log.err(`could not ${action} the daemon (${res.kind}): ${res.error}`);
    if (res.kind !== "unsupported") {
      log.hint("if the service was never installed, run `oma bridge setup`");
    }
    process.exit(1);
  }

  log.ok(`daemon ${PAST[action]} via ${res.kind}`);

  // For start/restart, give the daemon a moment then report liveness from the
  // state file it flushes on attach — same source `oma bridge status` reads.
  if (action !== "stop") {
    await new Promise((r) => setTimeout(r, 1200));
    const dstate = readDaemonState();
    if (dstate && isPidAlive(dstate.pid)) {
      const conn = dstate.connected ? c.green("connected") : c.yellow("connecting…");
      process.stderr.write(`  ${c.dim("daemon".padEnd(11))} ${conn}  ${c.dim(`pid ${dstate.pid} · up ${formatAge(Date.now() - dstate.startedAt).replace(/ ago$/, "")}`)}\n`);
    } else {
      log.hint("daemon is coming up — check `oma bridge status` in a moment");
    }
  }
}
