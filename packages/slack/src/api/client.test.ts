import { describe, expect, it } from "vitest";
import { FakeHttpClient } from "@duyet/oma-integrations-core/test-fakes";
import { SlackApiClient, SlackApiError } from "./client";

describe("SlackApiClient.postMessageBlocks", () => {
  it("threads the reply and forwards blocks", async () => {
    const http = new FakeHttpClient();
    http.respondWith({
      status: 200,
      headers: {},
      body: JSON.stringify({ ok: true, channel: "C1", ts: "1.2" }),
    });
    const client = new SlackApiClient(http);
    const res = await client.postMessageBlocks("xoxb", {
      channel: "C1",
      text: "hi",
      threadTs: "1700.1",
      blocks: [{ type: "divider" }],
    });
    expect(res).toEqual({ channel: "C1", ts: "1.2" });
    const body = JSON.parse(http.calls[0].body ?? "{}");
    expect(body.thread_ts).toBe("1700.1");
    expect(body.blocks).toEqual([{ type: "divider" }]);
  });
});

describe("SlackApiClient.updateMessage", () => {
  it("edits a message via chat.update", async () => {
    const http = new FakeHttpClient();
    http.respondWith({
      status: 200,
      headers: {},
      body: JSON.stringify({ ok: true, channel: "C1", ts: "1.2" }),
    });
    const client = new SlackApiClient(http);
    await client.updateMessage("xoxb", "C1", "1.2", { text: "updated" });
    expect(http.calls[0].url).toBe("https://slack.com/api/chat.update");
    const body = JSON.parse(http.calls[0].body ?? "{}");
    expect(body.ts).toBe("1.2");
    expect(body.text).toBe("updated");
  });

  it("throws on ok:false", async () => {
    const http = new FakeHttpClient();
    http.respondWith({
      status: 200,
      headers: {},
      body: JSON.stringify({ ok: false, error: "message_not_found" }),
    });
    const client = new SlackApiClient(http);
    await expect(client.updateMessage("xoxb", "C1", "x", { text: "y" })).rejects.toThrow(
      SlackApiError,
    );
  });
});

describe("SlackApiClient.uploadFile", () => {
  it("runs the three-step external upload flow", async () => {
    const http = new FakeHttpClient();
    http.respondWith(
      {
        status: 200,
        headers: {},
        body: JSON.stringify({ ok: true, upload_url: "https://files/up", file_id: "F1" }),
      },
      { status: 200, headers: {}, body: "OK" },
      { status: 200, headers: {}, body: JSON.stringify({ ok: true, files: [{ id: "F1" }] }) },
    );
    const client = new SlackApiClient(http);
    const res = await client.uploadFile("xoxb", {
      channel: "C1",
      threadTs: "1700.1",
      filename: "report.csv",
      content: "a,b\n1,2\n",
    });
    expect(res).toEqual({ fileId: "F1" });
    expect(http.calls).toHaveLength(3);
    expect(http.calls[0].url).toBe("https://slack.com/api/files.getUploadURLExternal");
    expect(http.calls[1].url).toBe("https://files/up");
    expect(http.calls[2].url).toBe("https://slack.com/api/files.completeUploadExternal");
    const completeBody = JSON.parse(http.calls[2].body ?? "{}");
    expect(completeBody.thread_ts).toBe("1700.1");
    expect(completeBody.files[0].id).toBe("F1");
  });

  it("throws when the reserve step fails", async () => {
    const http = new FakeHttpClient();
    http.respondWith({
      status: 200,
      headers: {},
      body: JSON.stringify({ ok: false, error: "invalid_auth" }),
    });
    const client = new SlackApiClient(http);
    await expect(
      client.uploadFile("xoxb", { channel: "C1", filename: "x.txt", content: "hi" }),
    ).rejects.toThrow(SlackApiError);
  });
});
