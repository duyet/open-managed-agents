import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CapacityUsage, K8sManager, SandboxHealthSnapshot } from "../src/k8s-manager";
import { SandboxMonitor } from "../src/sandbox-monitor";
import type { SlackNotifier } from "../src/slack-notifier";

function makeManager(overrides: {
  health?: SandboxHealthSnapshot[];
  capacity?: CapacityUsage;
  healthError?: boolean;
  capacityError?: boolean;
} = {}): K8sManager {
  return {
    getSandboxHealth: vi.fn(async () => {
      if (overrides.healthError) throw new Error("k8s api down");
      return overrides.health ?? [];
    }),
    getCapacityUsage: vi.fn(async () => {
      if (overrides.capacityError) throw new Error("k8s api down");
      return overrides.capacity ?? { cpuUsedPct: 10, memUsedPct: 10 };
    }),
  } as unknown as K8sManager;
}

function makeNotifier(): SlackNotifier & {
  notifySandboxCrashed: ReturnType<typeof vi.fn>;
  notifySandboxOOM: ReturnType<typeof vi.fn>;
  notifySandboxPending: ReturnType<typeof vi.fn>;
  notifyClusterLowCapacity: ReturnType<typeof vi.fn>;
} {
  return {
    notifySandboxCrashed: vi.fn().mockResolvedValue(undefined),
    notifySandboxOOM: vi.fn().mockResolvedValue(undefined),
    notifySandboxPending: vi.fn().mockResolvedValue(undefined),
    notifyClusterLowCapacity: vi.fn().mockResolvedValue(undefined),
  } as unknown as ReturnType<typeof makeNotifier>;
}

const silentLogger = { warn: vi.fn() };

describe("SandboxMonitor", () => {
  beforeEach(() => {
    silentLogger.warn.mockClear();
  });

  it("notifies on a pod stuck Pending past the threshold", async () => {
    const manager = makeManager({
      health: [
        {
          podName: "box-sess-1",
          sessionId: "sess_1",
          nodeName: "node-1",
          phase: "Pending",
          createdAt: new Date().toISOString(),
          pendingSeconds: 45,
          containers: [],
        },
      ],
    });
    const notifier = makeNotifier();
    const monitor = new SandboxMonitor(manager, notifier, { pendingThresholdMs: 30_000, logger: silentLogger });

    await monitor.checkOnce();

    expect(notifier.notifySandboxPending).toHaveBeenCalledWith("sess_1", 45);
  });

  it("does not notify a pod pending under the threshold", async () => {
    const manager = makeManager({
      health: [
        {
          podName: "box-sess-1",
          sessionId: "sess_1",
          nodeName: "node-1",
          phase: "Pending",
          createdAt: new Date().toISOString(),
          pendingSeconds: 10,
          containers: [],
        },
      ],
    });
    const notifier = makeNotifier();
    const monitor = new SandboxMonitor(manager, notifier, { pendingThresholdMs: 30_000, logger: silentLogger });

    await monitor.checkOnce();

    expect(notifier.notifySandboxPending).not.toHaveBeenCalled();
  });

  it("notifies sandbox_crashed on CrashLoopBackOff", async () => {
    const manager = makeManager({
      health: [
        {
          podName: "box-sess-2",
          sessionId: "sess_2",
          nodeName: "node-1",
          phase: "Running",
          createdAt: new Date().toISOString(),
          pendingSeconds: 0,
          containers: [
            {
              name: "sandbox",
              restartCount: 5,
              waitingReason: "CrashLoopBackOff",
              lastTerminatedReason: "Error",
            },
          ],
        },
      ],
    });
    const notifier = makeNotifier();
    const monitor = new SandboxMonitor(manager, notifier, { logger: silentLogger });

    await monitor.checkOnce();

    expect(notifier.notifySandboxCrashed).toHaveBeenCalledWith("sess_2", "Error");
  });

  it("notifies sandbox_oom when a container was OOMKilled", async () => {
    const manager = makeManager({
      health: [
        {
          podName: "box-sess-3",
          sessionId: "sess_3",
          nodeName: "node-1",
          phase: "Running",
          createdAt: new Date().toISOString(),
          pendingSeconds: 0,
          containers: [
            {
              name: "sandbox",
              restartCount: 1,
              terminatedReason: "OOMKilled",
              memoryLimit: "512Mi",
            },
          ],
        },
      ],
    });
    const notifier = makeNotifier();
    const monitor = new SandboxMonitor(manager, notifier, { logger: silentLogger });

    await monitor.checkOnce();

    expect(notifier.notifySandboxOOM).toHaveBeenCalledWith("sess_3", "unknown", "512Mi");
  });

  it("detects OOMKilled from lastState after the container restarted", async () => {
    const manager = makeManager({
      health: [
        {
          podName: "box-sess-4",
          sessionId: "sess_4",
          nodeName: "node-1",
          phase: "Running",
          createdAt: new Date().toISOString(),
          pendingSeconds: 0,
          containers: [
            {
              name: "sandbox",
              restartCount: 2,
              lastTerminatedReason: "OOMKilled",
              memoryLimit: "1Gi",
            },
          ],
        },
      ],
    });
    const notifier = makeNotifier();
    const monitor = new SandboxMonitor(manager, notifier, { logger: silentLogger });

    await monitor.checkOnce();

    expect(notifier.notifySandboxOOM).toHaveBeenCalledWith("sess_4", "unknown", "1Gi");
  });

  it("falls back to podName when sessionId is unknown", async () => {
    const manager = makeManager({
      health: [
        {
          podName: "box-orphan",
          sessionId: null,
          nodeName: "node-1",
          phase: "Running",
          createdAt: new Date().toISOString(),
          pendingSeconds: 0,
          containers: [{ name: "sandbox", restartCount: 3, waitingReason: "CrashLoopBackOff" }],
        },
      ],
    });
    const notifier = makeNotifier();
    const monitor = new SandboxMonitor(manager, notifier, { logger: silentLogger });

    await monitor.checkOnce();

    expect(notifier.notifySandboxCrashed).toHaveBeenCalledWith("box-orphan", "CrashLoopBackOff");
  });

  it("notifies cluster_low_capacity once usage crosses the threshold", async () => {
    const manager = makeManager({ capacity: { cpuUsedPct: 95, memUsedPct: 40 } });
    const notifier = makeNotifier();
    const monitor = new SandboxMonitor(manager, notifier, { lowCapacityUsedPct: 90, logger: silentLogger });

    await monitor.checkOnce();

    expect(notifier.notifyClusterLowCapacity).toHaveBeenCalledWith(95, 40);
  });

  it("does not notify cluster capacity when usage is under the threshold", async () => {
    const manager = makeManager({ capacity: { cpuUsedPct: 50, memUsedPct: 50 } });
    const notifier = makeNotifier();
    const monitor = new SandboxMonitor(manager, notifier, { lowCapacityUsedPct: 90, logger: silentLogger });

    await monitor.checkOnce();

    expect(notifier.notifyClusterLowCapacity).not.toHaveBeenCalled();
  });

  it("swallows sandbox health fetch errors without throwing (fail-open)", async () => {
    const manager = makeManager({ healthError: true });
    const notifier = makeNotifier();
    const monitor = new SandboxMonitor(manager, notifier, { logger: silentLogger });

    await expect(monitor.checkOnce()).resolves.toBeUndefined();
    expect(silentLogger.warn).toHaveBeenCalled();
    expect(notifier.notifySandboxCrashed).not.toHaveBeenCalled();
  });

  it("swallows cluster capacity fetch errors without throwing (fail-open)", async () => {
    const manager = makeManager({ capacityError: true });
    const notifier = makeNotifier();
    const monitor = new SandboxMonitor(manager, notifier, { logger: silentLogger });

    await expect(monitor.checkOnce()).resolves.toBeUndefined();
    expect(silentLogger.warn).toHaveBeenCalled();
    expect(notifier.notifyClusterLowCapacity).not.toHaveBeenCalled();
  });

  it("start()/stop() schedule and cancel a repeating check", async () => {
    vi.useFakeTimers();
    const manager = makeManager({ capacity: { cpuUsedPct: 10, memUsedPct: 10 } });
    const notifier = makeNotifier();
    const monitor = new SandboxMonitor(manager, notifier, { intervalMs: 1_000, logger: silentLogger });

    monitor.start();
    await vi.advanceTimersByTimeAsync(3_500);
    monitor.stop();
    const callsAtStop = (manager.getCapacityUsage as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsAtStop).toBeGreaterThanOrEqual(3);

    await vi.advanceTimersByTimeAsync(5_000);
    expect((manager.getCapacityUsage as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAtStop);

    vi.useRealTimers();
  });
});
