// @ts-nocheck
/**
 * Daemon-state snapshot file — the observability channel `oma bridge
 * status` reads to report daemon liveness. Covers the pure age formatter,
 * the fs round-trip (write → read), corrupt/missing tolerance, and the
 * pid-liveness probe.
 *
 * Test isolation mirrors cli-bridge-multi-tenant.test.ts: each test uses a
 * unique OMA_PROFILE so `paths().configDir` resolves to its own subdir
 * under the real HOME (workerd doesn't honor a redirected HOME env var).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  writeDaemonState,
  readDaemonState,
  formatAge,
  type DaemonState,
} from "../../packages/cli/src/bridge/lib/daemon-state";

// isPidAlive wraps process.kill(pid, 0), a Node-only syscall not
// implemented in the workers vitest pool — it's covered by the e2e
// lifecycle test against a real daemon process instead.

describe("formatAge", () => {
  it("renders compact buckets", () => {
    expect(formatAge(0)).toBe("just now");
    expect(formatAge(3000)).toBe("just now");
    expect(formatAge(8000)).toBe("8s ago");
    expect(formatAge(3 * 60_000)).toBe("3m ago");
    expect(formatAge(2 * 3600_000)).toBe("2h ago");
    expect(formatAge(4 * 86_400_000)).toBe("4d ago");
  });

  it("guards NaN / negative", () => {
    expect(formatAge(NaN)).toBe("unknown");
    expect(formatAge(-5)).toBe("unknown");
  });
});

describe("writeDaemonState / readDaemonState round-trip", () => {
  let profileCounter = 0;
  const ORIGINAL_PROFILE = process.env.OMA_PROFILE;
  let bridgeDir: string;

  beforeEach(() => {
    profileCounter += 1;
    process.env.OMA_PROFILE = `dstate${profileCounter}testz`;
    bridgeDir = join(homedir(), `.oma/bridge-${process.env.OMA_PROFILE}`);
  });
  afterEach(async () => {
    await rm(bridgeDir, { recursive: true, force: true });
    if (ORIGINAL_PROFILE === undefined) delete process.env.OMA_PROFILE;
    else process.env.OMA_PROFILE = ORIGINAL_PROFILE;
  });

  it("writes then reads back an identical snapshot", async () => {
    await mkdir(bridgeDir, { recursive: true });
    const state: DaemonState = {
      pid: 4242,
      startedAt: 1_700_000_000_000,
      attachedAt: 1_700_000_001_000,
      lastHeartbeatAt: 1_700_000_002_000,
      connected: true,
      tenantCount: 3,
    };
    writeDaemonState(state);
    expect(readDaemonState()).toEqual(state);
  });

  it("returns null when the file is missing", () => {
    expect(readDaemonState()).toBeNull();
  });

  it("returns null on corrupt JSON or a shape missing required fields", async () => {
    await mkdir(bridgeDir, { recursive: true });
    const file = join(bridgeDir, "daemon-state.json");
    await writeFile(file, "{ not json", "utf-8");
    expect(readDaemonState()).toBeNull();
    await writeFile(file, JSON.stringify({ connected: true }), "utf-8");
    expect(readDaemonState()).toBeNull();
  });

  it("normalizes optional nulls when absent", async () => {
    await mkdir(bridgeDir, { recursive: true });
    const file = join(bridgeDir, "daemon-state.json");
    await writeFile(file, JSON.stringify({ pid: 5, startedAt: 100 }), "utf-8");
    expect(readDaemonState()).toEqual({
      pid: 5,
      startedAt: 100,
      attachedAt: null,
      lastHeartbeatAt: null,
      connected: false,
      tenantCount: 0,
    });
  });
});
