import { describe, expect, it } from "vitest";
import { FakeHttpClient } from "@duyet/oma-integrations-core/test-fakes";
import { SlackApiClient, SlackApiError } from "./api/client";
import { formatSessionNotifyMessage, postSessionStatusMessage } from "./notify";

describe("formatSessionNotifyMessage", () => {
  it("renders an idle status with a green marker", () => {
    const text = formatSessionNotifyMessage({
      sessionId: "sess_123",
      status: "idle",
      agentName: "Reviewer",
    });
    expect(text).toContain(":large_green_circle:");
    expect(text).toContain('Agent "Reviewer"');
    expect(text).toContain("sess_123");
  });

  it("renders an error status with a red marker and includes detail", () => {
    const text = formatSessionNotifyMessage({
      sessionId: "sess_456",
      status: "error",
      detail: "rate_limited",
    });
    expect(text).toContain(":red_circle:");
    expect(text).toContain("hit an error");
    expect(text).toContain("rate_limited");
  });
});

describe("postSessionStatusMessage", () => {
  it("posts the formatted message to the configured channel via the bot token", async () => {
    const http = new FakeHttpClient();
    http.respondWith({
      status: 200,
      headers: {},
      body: JSON.stringify({ ok: true, channel: "C123", ts: "1234.5678" }),
    });
    const client = new SlackApiClient(http);

    const result = await postSessionStatusMessage(
      client,
      "xoxb-bot-token",
      { channel: "C123" },
      { sessionId: "sess_1", status: "idle" },
    );

    expect(result).toEqual({ channel: "C123", ts: "1234.5678" });
    expect(http.calls).toHaveLength(1);
    const call = http.calls[0];
    expect(call.method).toBe("POST");
    expect(call.url).toBe("https://slack.com/api/chat.postMessage");
    expect(call.headers?.authorization).toBe("Bearer xoxb-bot-token");
    const body = JSON.parse(call.body ?? "{}") as { channel: string; text: string };
    expect(body.channel).toBe("C123");
    expect(body.text).toContain("sess_1");
  });

  it("throws SlackApiError when Slack returns ok: false", async () => {
    const http = new FakeHttpClient();
    http.respondWith({
      status: 200,
      headers: {},
      body: JSON.stringify({ ok: false, error: "channel_not_found" }),
    });
    const client = new SlackApiClient(http);

    await expect(
      postSessionStatusMessage(
        client,
        "xoxb-bot-token",
        { channel: "C_missing" },
        { sessionId: "sess_2", status: "error" },
      ),
    ).rejects.toThrow(SlackApiError);
  });
});
