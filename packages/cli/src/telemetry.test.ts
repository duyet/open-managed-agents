// Unit tests for the local telemetry + counters modules. Both persist under
// a temp HOME / XDG dir so the real user config is never touched. CI env vars
// are scrubbed per-test because the harness itself usually runs under CI=1,
// which would otherwise force telemetry off.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// os.homedir() is cached per-process and ignores later HOME changes, so the
// only reliable way to redirect the config path to a temp dir per test is to
// mock it to read the current HOME at call time.
vi.mock("node:os", async (orig) => {
  const actual = (await orig()) as typeof import("node:os");
  return { ...actual, homedir: () => process.env.HOME ?? actual.homedir() };
});

let home: string;
let seq = 0;
const CI_VARS = [
  "CI",
  "CONTINUOUS_INTEGRATION",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "CIRCLECI",
  "TRAVIS",
  "BUILDKITE",
  "JENKINS_URL",
  "TEAMCITY_VERSION",
];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "oma-cfg-"));
  vi.resetModules();
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  for (const v of CI_VARS) delete process.env[v];
  delete process.env.OMA_TELEMETRY;
  delete process.env.DO_NOT_TRACK;
  // os.homedir() is cached per-process, so a fresh temp HOME alone doesn't
  // isolate the on-disk config path between tests. A unique profile slug per
  // test routes each to its own configDir / cli-config file, guaranteeing a
  // clean slate.
  process.env.OMA_PROFILE = `t${seq++}`;
});

afterEach(() => {
  try { rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("telemetry", () => {
  it("is enabled by default (opt-out)", async () => {
    const { telemetryStatus } = await import("./telemetry.js");
    expect(telemetryStatus().enabled).toBe(true);
  });

  it("respects OMA_TELEMETRY=0", async () => {
    process.env.OMA_TELEMETRY = "0";
    const { telemetryStatus } = await import("./telemetry.js");
    expect(telemetryStatus().enabled).toBe(false);
  });

  it("respects DO_NOT_TRACK=1", async () => {
    process.env.DO_NOT_TRACK = "1";
    const { telemetryStatus } = await import("./telemetry.js");
    expect(telemetryStatus().enabled).toBe(false);
  });

  it("is disabled under CI", async () => {
    process.env.CI = "true";
    const { telemetryStatus, isCI } = await import("./telemetry.js");
    expect(isCI()).toBe(true);
    expect(telemetryStatus().enabled).toBe(false);
  });

  it("persists the disable flag across reloads", async () => {
    const m1 = await import("./telemetry.js");
    m1.setTelemetryEnabled(false);
    vi.resetModules();
    const m2 = await import("./telemetry.js");
    expect(m2.telemetryStatus().enabled).toBe(false);
  });
});

describe("counters", () => {
  it("bumps command + relay totals", async () => {
    const { bumpCommand, bumpRelay, readCounters } = await import("./counters.js");
    bumpCommand();
    bumpCommand();
    bumpRelay();
    const c = readCounters();
    expect(c.commandsToday).toBe(2);
    expect(c.commandsTotal).toBe(2);
    expect(c.relayedToday).toBe(1);
    expect(c.relayedTotal).toBe(1);
  });

  it("rolls daily fields over on a new day but keeps totals", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T10:00:00Z"));
    const { bumpCommand, readCounters } = await import("./counters.js");
    bumpCommand();
    expect(readCounters().commandsToday).toBe(1);
    vi.setSystemTime(new Date("2026-01-02T10:00:00Z"));
    const rolled = readCounters();
    expect(rolled.commandsToday).toBe(0);
    expect(rolled.commandsTotal).toBe(1);
    vi.useRealTimers();
  });
});
