/**
 * Anonymous, opt-out CLI usage telemetry.
 *
 * What is sent (and NOTHING else): the command name (matcher tokens joined
 * with ".", e.g. "agents.list" — never arguments, paths, ids, or tokens),
 * the CLI version, the OS platform + arch, the Node version, and an
 * anonymous per-machine id (a sha256 hash of a random seed generated on
 * first run — carries no hostname, username, or any PII). One fire-and-
 * forget POST with a 1.5s timeout; any error (offline, DNS, 4xx/5xx, abort)
 * is swallowed. Telemetry must never slow down or break a command.
 *
 * Disabling, honored in this order:
 *   - `OMA_TELEMETRY=0` (or "false"/"off") env var
 *   - `oma telemetry disable` (persisted flag in cli-config.json)
 *   - a detected CI environment (never phones home from CI)
 *   - `DO_NOT_TRACK=1` (the do-not-track.com convention)
 *
 * On the first non-CI run a one-time notice is printed to stderr explaining
 * what is collected and how to turn it off, then a flag is persisted so it
 * never prints again.
 */

import { randomUUID, createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { currentProfile } from "./bridge/lib/platform.js";
import { PKG_VERSION } from "./bridge/lib/version.js";

interface CliConfig {
  /** false once the user runs `oma telemetry disable`. Default (absent) = on. */
  telemetry_enabled?: boolean;
  /** true once the first-run notice has been shown. */
  telemetry_notice_shown?: boolean;
  /** Anonymous, hashed machine id (64-hex). Generated on first read. */
  machine_id?: string;
}

function configPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  const profile = currentProfile();
  const file = profile ? `cli-config.${profile}.json` : "cli-config.json";
  return join(base, "oma", file);
}

function readCliConfig(): CliConfig {
  try {
    return JSON.parse(readFileSync(configPath(), "utf-8")) as CliConfig;
  } catch {
    return {};
  }
}

function writeCliConfig(cfg: CliConfig): void {
  try {
    const path = configPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(cfg, null, 2), "utf-8");
  } catch {
    /* best-effort — never fatal */
  }
}

/** Return (creating + persisting on first call) the anonymous machine id. */
function machineId(cfg: CliConfig): string {
  if (cfg.machine_id && /^[0-9a-f]{64}$/.test(cfg.machine_id)) return cfg.machine_id;
  const id = createHash("sha256").update(randomUUID()).digest("hex");
  cfg.machine_id = id;
  writeCliConfig(cfg);
  return id;
}

/** Detect common CI environments — telemetry stays silent there. */
export function isCI(): boolean {
  const e = process.env;
  return !!(
    e.CI ||
    e.CONTINUOUS_INTEGRATION ||
    e.GITHUB_ACTIONS ||
    e.GITLAB_CI ||
    e.CIRCLECI ||
    e.TRAVIS ||
    e.BUILDKITE ||
    e.JENKINS_URL ||
    e.TEAMCITY_VERSION
  );
}

function envDisabled(): boolean {
  const v = (process.env.OMA_TELEMETRY ?? "").toLowerCase();
  if (v === "0" || v === "false" || v === "off" || v === "no") return true;
  const dnt = (process.env.DO_NOT_TRACK ?? "").toLowerCase();
  return dnt === "1" || dnt === "true";
}

/** Whether telemetry should run for this invocation. */
export function telemetryEnabled(cfg: CliConfig = readCliConfig()): boolean {
  if (envDisabled()) return false;
  if (isCI()) return false;
  return cfg.telemetry_enabled !== false;
}

/** Persist the on/off flag. Used by `oma telemetry enable|disable`. */
export function setTelemetryEnabled(enabled: boolean): void {
  const cfg = readCliConfig();
  cfg.telemetry_enabled = enabled;
  writeCliConfig(cfg);
}

/** Human-readable current state for `oma telemetry status`. */
export function telemetryStatus(): {
  enabled: boolean;
  reason: string;
  configFile: string;
} {
  const cfg = readCliConfig();
  if (envDisabled()) return { enabled: false, reason: "disabled by OMA_TELEMETRY / DO_NOT_TRACK env", configFile: configPath() };
  if (isCI()) return { enabled: false, reason: "disabled (CI environment detected)", configFile: configPath() };
  if (cfg.telemetry_enabled === false) return { enabled: false, reason: "disabled via `oma telemetry disable`", configFile: configPath() };
  return { enabled: true, reason: "enabled (opt-out; set OMA_TELEMETRY=0 or run `oma telemetry disable`)", configFile: configPath() };
}

const NOTICE = `\x1b[2moma collects anonymous usage telemetry (command name, version, OS — no\narguments, paths, or credentials) to guide development. Opt out any time:\n  oma telemetry disable      (or set OMA_TELEMETRY=0)\x1b[0m\n`;

/** Print the one-time first-run telemetry notice, then mark it shown. No-op
 *  in CI or once already shown. Printed to stderr so it never pollutes
 *  piped stdout. */
function maybePrintNotice(cfg: CliConfig): void {
  if (isCI()) return;
  if (cfg.telemetry_notice_shown) return;
  cfg.telemetry_notice_shown = true;
  writeCliConfig(cfg);
  const plain = process.env.NO_COLOR || !process.stderr.isTTY;
  process.stderr.write(plain ? NOTICE.replace(/\x1b\[[0-9;]*m/g, "") : NOTICE);
}

/**
 * Fire-and-forget a telemetry event. Resolves immediately regardless of
 * outcome; callers should NOT await it in a way that delays the command.
 * The one-time notice is printed the first time this runs while enabled.
 */
export function recordCommand(baseUrl: string, command: string): void {
  const cfg = readCliConfig();
  if (!telemetryEnabled(cfg)) return;
  maybePrintNotice(cfg);

  const body = JSON.stringify({
    event: "command",
    command,
    cli_version: PKG_VERSION,
    os: process.platform,
    arch: process.arch,
    node_version: process.versions.node,
    machine_id: machineId(cfg),
  });

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 1500);
  // Do not let the pending request keep the process alive.
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
  void fetch(`${baseUrl.replace(/\/+$/, "")}/v1/telemetry/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "Mozilla/5.0 (compatible; OMA-CLI/0.1; +https://oma.duyet.net)",
    },
    body,
    signal: ctl.signal,
  })
    .catch(() => undefined)
    .finally(() => clearTimeout(timer));
}
