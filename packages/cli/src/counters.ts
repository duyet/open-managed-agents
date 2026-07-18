/**
 * Local, best-effort usage counters for the CLI + bridge daemon.
 *
 * Purely observational — surfaced by `oma bridge status` so an operator can
 * see, at a glance, how much this machine has done today. Never transmitted
 * anywhere (that is telemetry.ts's job, and it sends only the command name,
 * not these totals). Every read/write is wrapped so a corrupt or unwritable
 * file can never break a command or take the daemon down.
 *
 * Stored next to the daemon state under the profile-aware bridge configDir,
 * so multiple `--profile` daemons keep independent counters and the file
 * lives beside the creds it describes.
 *
 * Daily fields (`relayedToday`, `commandsToday`) roll over when the local
 * date changes; lifetime totals never reset.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { paths } from "./bridge/lib/platform.js";

export interface Counters {
  /** Local date (YYYY-MM-DD) the `*Today` fields are scoped to. */
  day: string;
  /** Sessions relayed through the daemon today. */
  relayedToday: number;
  /** Sessions relayed since the counters file was created. */
  relayedTotal: number;
  /** CLI commands invoked today. */
  commandsToday: number;
  /** CLI commands invoked since the counters file was created. */
  commandsTotal: number;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function countersPath(): string {
  return join(paths().configDir, "counters.json");
}

function empty(): Counters {
  return {
    day: today(),
    relayedToday: 0,
    relayedTotal: 0,
    commandsToday: 0,
    commandsTotal: 0,
  };
}

/** Read the counters file, or a fresh zeroed one. Rolls daily fields over
 *  when the stored day is stale. Never throws. */
export function readCounters(): Counters {
  let parsed: Partial<Counters> | null = null;
  try {
    parsed = JSON.parse(readFileSync(countersPath(), "utf-8")) as Partial<Counters>;
  } catch {
    return empty();
  }
  const c: Counters = {
    day: typeof parsed.day === "string" ? parsed.day : today(),
    relayedToday: typeof parsed.relayedToday === "number" ? parsed.relayedToday : 0,
    relayedTotal: typeof parsed.relayedTotal === "number" ? parsed.relayedTotal : 0,
    commandsToday: typeof parsed.commandsToday === "number" ? parsed.commandsToday : 0,
    commandsTotal: typeof parsed.commandsTotal === "number" ? parsed.commandsTotal : 0,
  };
  if (c.day !== today()) {
    c.day = today();
    c.relayedToday = 0;
    c.commandsToday = 0;
  }
  return c;
}

function write(c: Counters): void {
  try {
    const path = countersPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(c), "utf-8");
  } catch {
    /* observability only — never fatal */
  }
}

/** Bump the CLI-command counters. Called once per invocation. */
export function bumpCommand(): void {
  const c = readCounters();
  c.commandsToday += 1;
  c.commandsTotal += 1;
  write(c);
}

/** Bump the relayed-session counters. Called by the daemon on session.start. */
export function bumpRelay(): void {
  const c = readCounters();
  c.relayedToday += 1;
  c.relayedTotal += 1;
  write(c);
}
