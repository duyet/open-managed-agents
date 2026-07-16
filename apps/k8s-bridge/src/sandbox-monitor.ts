import type { K8sManager } from "./k8s-manager";
import type { SlackNotifier } from "./slack-notifier";

export interface SandboxMonitorOptions {
  /** How long a pod may sit in `Pending` before `sandbox.pending` fires. Default 30s (per issue #86). */
  pendingThresholdMs?: number;
  /** Cluster is "low capacity" once used CPU/memory crosses this percentage. Default 90 (i.e. <10% allocatable free). */
  lowCapacityUsedPct?: number;
  /** Poll interval for `start()`. Default 15s. */
  intervalMs?: number;
  logger?: { warn: (msg: string, ctx?: unknown) => void };
}

/**
 * Polls the cluster for sandbox pod health (OOMKilled, CrashLoopBackOff,
 * stuck Pending) and cluster capacity, forwarding to SlackNotifier.
 * Never throws — a failed poll is logged and skipped so it can never
 * interfere with sandbox operations.
 */
export class SandboxMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly pendingThresholdMs: number;
  private readonly lowCapacityUsedPct: number;
  private readonly intervalMs: number;
  private readonly logger: { warn: (msg: string, ctx?: unknown) => void };

  constructor(
    private manager: K8sManager,
    private notifier: SlackNotifier,
    options: SandboxMonitorOptions = {},
  ) {
    this.pendingThresholdMs = options.pendingThresholdMs ?? 30_000;
    this.lowCapacityUsedPct = options.lowCapacityUsedPct ?? 90;
    this.intervalMs = options.intervalMs ?? 15_000;
    this.logger = options.logger ?? console;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.checkOnce().catch((err) => this.logger.warn("sandbox-monitor: check failed", err));
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async checkOnce(): Promise<void> {
    await Promise.allSettled([this.checkSandboxes(), this.checkClusterCapacity()]);
  }

  private async checkSandboxes(): Promise<void> {
    const snapshots = await this.manager.getSandboxHealth().catch((err) => {
      this.logger.warn("sandbox-monitor: failed to fetch sandbox health", err);
      return [];
    });

    for (const snap of snapshots) {
      const id = snap.sessionId ?? snap.podName;

      if (snap.phase === "Pending" && snap.pendingSeconds * 1000 >= this.pendingThresholdMs) {
        this.notifier.notifySandboxPending(id, snap.pendingSeconds).catch(() => {});
      }

      for (const container of snap.containers) {
        if (container.waitingReason === "CrashLoopBackOff") {
          const reason = container.lastTerminatedReason ?? container.waitingReason;
          this.notifier.notifySandboxCrashed(id, reason).catch(() => {});
        }

        const oomReason =
          container.terminatedReason === "OOMKilled" || container.lastTerminatedReason === "OOMKilled"
            ? "OOMKilled"
            : undefined;
        if (oomReason) {
          this.notifier.notifySandboxOOM(id, "unknown", container.memoryLimit ?? "unknown").catch(() => {});
        }
      }
    }
  }

  private async checkClusterCapacity(): Promise<void> {
    const usage = await this.manager.getCapacityUsage().catch((err) => {
      this.logger.warn("sandbox-monitor: failed to fetch cluster capacity", err);
      return null;
    });
    if (!usage) return;

    if (usage.cpuUsedPct >= this.lowCapacityUsedPct || usage.memUsedPct >= this.lowCapacityUsedPct) {
      this.notifier.notifyClusterLowCapacity(usage.cpuUsedPct, usage.memUsedPct).catch(() => {});
    }
  }
}
