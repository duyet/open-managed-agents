export type NotifyEvent = "box_created" | "box_destroyed" | "box_error" | "health_degraded";

export class SlackNotifier {
  constructor(
    private webhookUrl: string,
    private notifyOn: string[],
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

  private shouldNotify(event: NotifyEvent): boolean {
    return this.notifyOn.includes(event);
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
