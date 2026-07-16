import { describe, expect, it } from "vitest";
import type {
  PostMessageInput,
  PostMessageResult,
  SlackBlock,
  UploadFileInput,
} from "./api/client";
import type { SlackApiClient } from "./api/client";
import {
  SlackThreadReporter,
  driveSlackThread,
  type SlackSessionEvent,
} from "./thread-reporter";

interface Recorded {
  posts: PostMessageInput[];
  updates: Array<{ ts: string; text: string; blocks?: SlackBlock[] }>;
  uploads: UploadFileInput[];
}

/** A hand-rolled SlackApiClient double — only the methods the reporter uses. */
function mockClient(): { client: SlackApiClient; rec: Recorded } {
  const rec: Recorded = { posts: [], updates: [], uploads: [] };
  let seq = 0;
  const client = {
    async postMessageBlocks(_token: string, input: PostMessageInput): Promise<PostMessageResult> {
      rec.posts.push(input);
      return { channel: input.channel, ts: `ts_${++seq}` };
    },
    async updateMessage(
      _token: string,
      channel: string,
      ts: string,
      input: { text: string; blocks?: SlackBlock[] },
    ): Promise<PostMessageResult> {
      rec.updates.push({ ts, text: input.text, blocks: input.blocks });
      return { channel, ts };
    },
    async uploadFile(_token: string, input: UploadFileInput) {
      rec.uploads.push(input);
      return { fileId: `file_${rec.uploads.length}` };
    },
  } as unknown as SlackApiClient;
  return { client, rec };
}

const baseOpts = {
  botToken: "xoxb-1",
  target: { channel: "C1", threadTs: "1700.1" },
  headline: "Investigate API latency spike",
  agentName: "OMA Agent",
  sessionUrl: "https://console/sess_1",
};

async function* stream(events: SlackSessionEvent[]): AsyncIterable<SlackSessionEvent> {
  for (const e of events) yield e;
}

describe("SlackThreadReporter", () => {
  it("posts an initial threaded status message on start", async () => {
    const { client, rec } = mockClient();
    const r = new SlackThreadReporter(client, baseOpts);
    await r.start();
    expect(rec.posts).toHaveLength(1);
    expect(rec.posts[0].threadTs).toBe("1700.1");
    expect(rec.posts[0].channel).toBe("C1");
  });

  it("updates the status message as sub-agents report progress", async () => {
    const { client, rec } = mockClient();
    const r = new SlackThreadReporter(client, baseOpts);
    await r.start();
    await r.handle({ type: "subagent.started", label: "Check Datadog" });
    await r.handle({ type: "subagent.finished", label: "Check Datadog", success: true });
    // Two updates: one for start, one for finish — both editing the same ts.
    expect(rec.updates.length).toBeGreaterThanOrEqual(2);
    expect(rec.updates.every((u) => u.ts === "ts_1")).toBe(true);
    const last = JSON.stringify(rec.updates.at(-1)?.blocks);
    expect(last).toContain("Check Datadog");
    expect(last).toContain("white_check_mark");
  });

  it("finalizes with the last agent message and uploads produced files", async () => {
    const { client, rec } = mockClient();
    const r = new SlackThreadReporter(client, baseOpts);
    await r.start();
    await r.handle({ type: "agent.message", text: "first partial" });
    await r.handle({ type: "agent.message", text: "Final synthesis of findings." });
    await r.handle({
      type: "file.produced",
      filename: "report.csv",
      content: "a,b\n1,2\n",
      title: "Report",
    });
    const done = await r.handle({ type: "session.status_idle" });
    expect(done).toBe(true);

    const finalUpdate = rec.updates.at(-1);
    expect(JSON.stringify(finalUpdate?.blocks)).toContain("Final synthesis of findings.");
    expect(rec.uploads).toHaveLength(1);
    expect(rec.uploads[0].filename).toBe("report.csv");
    expect(rec.uploads[0].threadTs).toBe("1700.1");
  });

  it("surfaces a friendly error on session.error", async () => {
    const { client, rec } = mockClient();
    const r = new SlackThreadReporter(client, baseOpts);
    await r.start();
    const done = await r.handle({ type: "session.error", message: "model overloaded" });
    expect(done).toBe(true);
    const last = rec.updates.at(-1);
    expect(JSON.stringify(last?.blocks)).toContain("model overloaded");
    expect(JSON.stringify(last?.blocks)).toContain("warning");
  });

  it("ignores events after finalization", async () => {
    const { client, rec } = mockClient();
    const r = new SlackThreadReporter(client, baseOpts);
    await r.start();
    await r.handle({ type: "session.status_idle" });
    const updatesAfterFinal = rec.updates.length;
    await r.handle({ type: "agent.message", text: "late" });
    expect(rec.updates.length).toBe(updatesAfterFinal);
  });
});

describe("driveSlackThread", () => {
  it("consumes an event stream and finalizes on idle", async () => {
    const { client, rec } = mockClient();
    await driveSlackThread(
      client,
      stream([
        { type: "agent.tool_use", name: "grep" },
        { type: "agent.message", text: "All done." },
        { type: "session.status_idle" },
      ]),
      baseOpts,
    );
    expect(rec.posts).toHaveLength(1);
    expect(JSON.stringify(rec.updates.at(-1)?.blocks)).toContain("All done.");
  });

  it("posts a timeout message when the stream stalls past the deadline", async () => {
    const { client, rec } = mockClient();
    // A stream that yields one event then hangs forever.
    async function* hanging(): AsyncIterable<SlackSessionEvent> {
      yield { type: "agent.tool_use", name: "bash" };
      await new Promise(() => {});
    }
    await driveSlackThread(client, hanging(), { ...baseOpts, timeoutMs: 20 });
    const last = rec.updates.at(-1);
    expect(JSON.stringify(last?.blocks)).toContain("Timed out");
  });

  it("does not abort the turn when a mid-stream status update throws", async () => {
    const rec: Recorded = { posts: [], updates: [], uploads: [] };
    let failNext = false;
    const client = {
      async postMessageBlocks(_t: string, input: PostMessageInput): Promise<PostMessageResult> {
        rec.posts.push(input);
        return { channel: input.channel, ts: "ts_1" };
      },
      async updateMessage(
        _t: string,
        channel: string,
        ts: string,
        input: { text: string; blocks?: SlackBlock[] },
      ): Promise<PostMessageResult> {
        if (failNext) {
          failNext = false;
          throw new Error("slack 500");
        }
        rec.updates.push({ ts, text: input.text, blocks: input.blocks });
        return { channel, ts };
      },
      async uploadFile() {
        return { fileId: "f" };
      },
    } as unknown as SlackApiClient;

    failNext = true; // first progress update throws
    await driveSlackThread(
      client,
      stream([
        { type: "agent.tool_use", name: "grep" }, // update throws, swallowed
        { type: "agent.message", text: "Recovered fine." },
        { type: "session.status_idle" },
      ]),
      baseOpts,
    );
    // Turn still finalized despite the transient failure.
    expect(JSON.stringify(rec.updates.at(-1)?.blocks)).toContain("Recovered fine.");
  });
});
