import { describe, expect, it } from "vitest";
import { FakeHttpClient } from "@duyet/oma-integrations-core/test-fakes";
import { MatrixApiClient, MatrixApiError } from "./api/client";
import { formatSessionNotifyMessage, postSessionStatusMessage } from "./notify";

describe("formatSessionNotifyMessage", () => {
  it("renders an idle status with an [idle] marker", () => {
    const text = formatSessionNotifyMessage({
      sessionId: "sess_123",
      status: "idle",
      agentName: "Reviewer",
    });
    expect(text).toContain("[idle]");
    expect(text).toContain('Agent "Reviewer"');
    expect(text).toContain("sess_123");
  });

  it("renders an error status with an [error] marker and includes detail", () => {
    const text = formatSessionNotifyMessage({
      sessionId: "sess_456",
      status: "error",
      detail: "rate_limited",
    });
    expect(text).toContain("[error]");
    expect(text).toContain("hit an error");
    expect(text).toContain("rate_limited");
  });
});

describe("postSessionStatusMessage", () => {
  it("PUTs the formatted message to the configured room via the access token", async () => {
    const http = new FakeHttpClient();
    http.respondWith({
      status: 200,
      headers: {},
      body: JSON.stringify({ event_id: "$abc123:matrix.org" }),
    });
    const client = new MatrixApiClient(http);

    const result = await postSessionStatusMessage(
      client,
      "mat_access_token",
      { homeserverUrl: "https://matrix.example.com", roomId: "!room:example.com" },
      { sessionId: "sess_1", status: "idle" },
    );

    expect(result).toEqual({ eventId: "$abc123:matrix.org" });
    expect(http.calls).toHaveLength(1);
    const call = http.calls[0];
    expect(call.method).toBe("PUT");
    expect(call.url).toContain("https://matrix.example.com/_matrix/client/v3/rooms/");
    expect(call.url).toContain(encodeURIComponent("!room:example.com"));
    expect(call.headers?.authorization).toBe("Bearer mat_access_token");
    const body = JSON.parse(call.body ?? "{}") as { msgtype: string; body: string };
    expect(body.msgtype).toBe("m.text");
    expect(body.body).toContain("sess_1");
  });

  it("strips a trailing slash from the homeserver URL", async () => {
    const http = new FakeHttpClient();
    http.respondWith({ status: 200, headers: {}, body: JSON.stringify({ event_id: "$x:example.com" }) });
    const client = new MatrixApiClient(http);

    await client.sendMessage("token", "https://matrix.example.com/", "!room:example.com", "hi");

    expect(http.calls[0].url.startsWith("https://matrix.example.com/_matrix/")).toBe(true);
    expect(http.calls[0].url).not.toContain("//_matrix");
  });

  it("throws MatrixApiError on a non-2xx response", async () => {
    const http = new FakeHttpClient();
    http.respondWith({ status: 403, headers: {}, body: JSON.stringify({ errcode: "M_FORBIDDEN" }) });
    const client = new MatrixApiClient(http);

    await expect(
      postSessionStatusMessage(
        client,
        "bad_token",
        { homeserverUrl: "https://matrix.example.com", roomId: "!room:example.com" },
        { sessionId: "sess_2", status: "error" },
      ),
    ).rejects.toThrow(MatrixApiError);
  });
});
