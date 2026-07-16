// Outbound Slack thread reporting for a running agent session.
//
// Bridges the session event log (see AGENTS.md "Event Types") to a single
// live Slack thread: posts a "thinking…" status message, rewrites it in place
// as the agent works and delegates to sub-agents, then replaces it with the
// final formatted response (plus any generated file attachments). On error or
// timeout it surfaces a friendly message instead of going silent.
//
// The state machine (`SlackThreadReporter`) is deliberately pure w.r.t. time —
// it reacts to events fed to it. `driveSlackThread` wires an async event
// stream and a wall-clock timeout on top, so the machine stays trivially unit
// testable with a mocked client and a hand-fed event list.

import type { PostMessageResult, SlackApiClient, UploadFileInput } from "./api/client";
import {
  renderErrorBlocks,
  renderFinalResponseBlocks,
  renderFinalResponseText,
  renderProgressBlocks,
  renderProgressText,
  type ProgressStep,
} from "./blocks";

/**
 * Narrow projection of the OMA session event log that the reporter cares
 * about. The host adapter maps real session events onto this shape; the
 * reporter never depends on the full event union.
 */
export type SlackSessionEvent =
  | { type: "agent.status"; summary?: string; state?: string }
  | { type: "agent.tool_use"; name: string }
  | { type: "agent.message"; text: string }
  | { type: "subagent.started"; label: string }
  | { type: "subagent.finished"; label: string; success: boolean }
  | { type: "file.produced"; filename: string; content: string; title?: string }
  | { type: "session.status_idle" }
  | { type: "session.error"; message?: string };

export interface SlackThreadTarget {
  channel: string;
  /** Parent message ts — replies are always threaded under it. */
  threadTs: string;
}

export interface SlackThreadReporterOptions {
  botToken: string;
  target: SlackThreadTarget;
  /** Headline shown while working (usually the user's request, trimmed). */
  headline: string;
  agentName?: string;
  /** Deep link to the session in Console, appended to final/error messages. */
  sessionUrl?: string;
}

/**
 * Drives one Slack thread for the lifetime of a session turn. Instantiate,
 * `start()`, feed events with `handle()`, and the machine self-finalizes when
 * it sees `session.status_idle` / `session.error`. `fail()` covers timeouts.
 */
export class SlackThreadReporter {
  private statusTs: string | null = null;
  private readonly steps: ProgressStep[] = [];
  private readonly stepIndex = new Map<string, number>();
  private finalText = "";
  private readonly pendingFiles: Array<{ filename: string; content: string; title?: string }> = [];
  private finalized = false;

  constructor(
    private readonly client: SlackApiClient,
    private readonly opts: SlackThreadReporterOptions,
  ) {}

  /** Post the initial "thinking…" status message. Idempotent. */
  async start(): Promise<void> {
    if (this.statusTs) return;
    const res = await this.postStatus();
    this.statusTs = res.ts;
  }

  /** Feed one session event. Returns true once the turn has been finalized. */
  async handle(event: SlackSessionEvent): Promise<boolean> {
    if (this.finalized) return true;
    switch (event.type) {
      case "agent.status":
        if (event.summary) await this.setHeadlineStep(event.summary);
        break;
      case "agent.tool_use":
        await this.markStep(`tool:${event.name}`, `Running \`${event.name}\``, "done");
        break;
      case "subagent.started":
        await this.markStep(`sub:${event.label}`, event.label, "running");
        break;
      case "subagent.finished":
        await this.markStep(
          `sub:${event.label}`,
          event.label,
          event.success ? "done" : "failed",
        );
        break;
      case "agent.message":
        // Keep only the latest full agent message as the response body.
        if (event.text.trim()) this.finalText = event.text;
        break;
      case "file.produced":
        this.pendingFiles.push(event);
        break;
      case "session.status_idle":
        await this.finishOk();
        return true;
      case "session.error":
        await this.fail(event.message ?? "The session ended with an error.");
        return true;
    }
    return false;
  }

  /** Surface a friendly error/timeout message and stop. Idempotent. */
  async fail(reason: string): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    const blocks = renderErrorBlocks(reason, this.opts.sessionUrl);
    const text = `The agent couldn't finish this request: ${reason}`;
    if (this.statusTs) {
      await this.client.updateMessage(this.opts.botToken, this.opts.target.channel, this.statusTs, {
        text,
        blocks,
      });
    } else {
      await this.client.postMessageBlocks(this.opts.botToken, {
        channel: this.opts.target.channel,
        threadTs: this.opts.target.threadTs,
        text,
        blocks,
      });
    }
  }

  private async finishOk(): Promise<void> {
    this.finalized = true;
    const body = this.finalText.trim() || "Done.";
    const blocks = renderFinalResponseBlocks({
      agentName: this.opts.agentName,
      body,
      sessionUrl: this.opts.sessionUrl,
    });
    const text = renderFinalResponseText({ body });
    if (this.statusTs) {
      await this.client.updateMessage(this.opts.botToken, this.opts.target.channel, this.statusTs, {
        text,
        blocks,
      });
    } else {
      await this.client.postMessageBlocks(this.opts.botToken, {
        channel: this.opts.target.channel,
        threadTs: this.opts.target.threadTs,
        text,
        blocks,
      });
    }
    for (const file of this.pendingFiles) {
      const upload: UploadFileInput = {
        channel: this.opts.target.channel,
        threadTs: this.opts.target.threadTs,
        filename: file.filename,
        content: file.content,
        title: file.title,
      };
      await this.client.uploadFile(this.opts.botToken, upload);
    }
  }

  private async setHeadlineStep(summary: string): Promise<void> {
    await this.markStep(`status:${summary}`, summary, "running");
  }

  private async markStep(key: string, label: string, state: ProgressStep["state"]): Promise<void> {
    const existing = this.stepIndex.get(key);
    if (existing === undefined) {
      this.stepIndex.set(key, this.steps.length);
      this.steps.push({ label, state });
    } else {
      this.steps[existing] = { label, state };
    }
    await this.refreshStatus();
  }

  private async refreshStatus(): Promise<void> {
    if (!this.statusTs) return;
    await this.client.updateMessage(this.opts.botToken, this.opts.target.channel, this.statusTs, {
      text: renderProgressText({ headline: this.opts.headline, steps: this.steps }),
      blocks: renderProgressBlocks({ headline: this.opts.headline, steps: this.steps }),
    });
  }

  private postStatus(): Promise<PostMessageResult> {
    return this.client.postMessageBlocks(this.opts.botToken, {
      channel: this.opts.target.channel,
      threadTs: this.opts.target.threadTs,
      text: renderProgressText({ headline: this.opts.headline, steps: this.steps }),
      blocks: renderProgressBlocks({ headline: this.opts.headline, steps: this.steps }),
    });
  }
}

export interface DriveSlackThreadOptions extends SlackThreadReporterOptions {
  /** Milliseconds before the turn is abandoned with a timeout message. */
  timeoutMs?: number;
}

/**
 * Consume an async stream of session events into a Slack thread, applying a
 * wall-clock timeout. Resolves once the turn is finalized (idle, error, or
 * timeout). Never rejects on a Slack API hiccup mid-stream — a failed status
 * update shouldn't abort the whole turn — but a failure while posting the
 * terminal message does propagate.
 */
export async function driveSlackThread(
  client: SlackApiClient,
  events: AsyncIterable<SlackSessionEvent>,
  options: DriveSlackThreadOptions,
): Promise<void> {
  const reporter = new SlackThreadReporter(client, options);
  await reporter.start();

  const timeoutMs = options.timeoutMs ?? 60_000;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve();
    }, timeoutMs);
  });

  const drain = (async () => {
    for await (const event of events) {
      if (timedOut) return;
      try {
        const done = await reporter.handle(event);
        if (done) return;
      } catch {
        // A transient Slack error on a progress update is swallowed so the
        // agent keeps running; the terminal post has its own error handling.
      }
    }
  })();

  await Promise.race([drain, timeout]);
  if (timer) clearTimeout(timer);
  if (timedOut) {
    await reporter.fail(`Timed out after ${Math.round(timeoutMs / 1000)}s.`);
  }
}
