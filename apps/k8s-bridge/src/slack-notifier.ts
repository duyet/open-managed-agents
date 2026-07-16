export type NotifyEvent =
  | "box_created"
  | "box_destroyed"
  | "box_error"
  | "health_degraded"
  | "sandbox_crashed"
  | "sandbox_oom"
  | "sandbox_pending"
  | "cluster_low_capacity";

const DEFAULT_DEBOUNCE_MS = 30_000;

export class SlackNotifier {
  private lastSentAt = new Map<string, number>();

  constructor(
    private webhookUrl: string,
    private notifyOn: string[],
    private debounceMs: number = DEFAULT_DEBOUNCE_MS,
  ) {}

  async notifyBoxCreated(boxId: string, sessionId: string): Promise<void> {
    if (!this.shouldNotify("box_created")) return;
    await this.send(`Box created: \`${boxId}\` (session: \`${sessionId}\`)`, "#36a64f");
  }

  async notifyBoxDestroyed(boxId: string): Promise<void> {
    if (!this.shouldNotify("box_destroyed")) return;
    await this.send(`Box destroyed: \`${boxId}\``, "#eda01d");
  }

  async notifyBoxError(boxId: string, error: string): Promise<void> {
    if (!this.shouldNotify("box_error")) return;
    await this.send(`Box error: \`${boxId}\`\n\`\`\`\n${error}\n\`\`\``, "#dc3545");
  }

  async notifyHealthDegraded(issue: string): Promise<void> {
    if (!this.shouldNotify("health_degraded")) return;
    await this.send(`Health degraded: ${issue}`, "#dc3545");
  }

  async notifySandboxCrashed(sessionId: string, reason: string): Promise<void> {
    if (!this.shouldNotify("sandbox_crashed", sessionId)) return;
    await this.send(`⚠️ Sandbox \`${sessionId}\` crashed: ${reason}`, "#dc3545");
  }

  async notifySandboxOOM(sessionId: string, usedMemory: string, memoryLimit: string): Promise<void> {
    if (!this.shouldNotify("sandbox_oom", sessionId)) return;
    await this.send(`🔥 Sandbox \`${sessionId}\` OOM-killed (used ${usedMemory} of ${memoryLimit})`, "#dc3545");
  }

  async notifySandboxPending(sessionId: string, durationSeconds: number): Promise<void> {
    if (!this.shouldNotify("sandbox_pending", sessionId)) return;
    await this.send(`⏳ Sandbox \`${sessionId}\` pending for ${durationSeconds}s`, "#eda01d");
  }

  async notifyClusterLowCapacity(cpuUsedPct: number, memUsedPct: number): Promise<void> {
    if (!this.shouldNotify("cluster_low_capacity")) return;
    await this.send(`🚨 Cluster capacity critical: ${cpuUsedPct}% CPU, ${memUsedPct}% memory used`, "#dc3545");
  }

  /**
   * Checks the notifyOn allowlist and, when `debounceKey` is given, suppresses
   * repeat sends of the same event for the same key within `debounceMs`
   * (e.g. a crash-looping pod firing `sandbox_crashed` every few seconds).
   */
  private shouldNotify(event: NotifyEvent, debounceKey?: string): boolean {
    if (!this.notifyOn.includes(event)) return false;
    if (debounceKey === undefined) return true;

    const key = `${event}:${debounceKey}`;
    const now = Date.now();
    const last = this.lastSentAt.get(key);
    if (last !== undefined && now - last < this.debounceMs) return false;

    this.lastSentAt.set(key, now);
    return true;
  }

  private async send(text: string, color?: string): Promise<void> {
    const payload: Record<string, unknown> = { text };
    if (color) {
      payload.attachments = [{ color, text }];
    }
    await fetch(this.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  }
}
