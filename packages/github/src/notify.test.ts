import { describe, expect, it } from "vitest";
import { FakeHttpClient } from "@duyet/oma-integrations-core/test-fakes";
import { GitHubApiClient } from "./api/client";
import { formatSessionNotifyComment, postSessionStatusComment } from "./notify";

describe("formatSessionNotifyComment", () => {
  it("renders an idle status with a green marker", () => {
    const text = formatSessionNotifyComment({
      sessionId: "sess_123",
      status: "idle",
      agentName: "Reviewer",
    });
    expect(text).toContain("🟢");
    expect(text).toContain('Agent "Reviewer"');
    expect(text).toContain("sess_123");
    expect(text).toContain("finished and is waiting for input");
  });

  it("renders an error status with a red marker and includes detail", () => {
    const text = formatSessionNotifyComment({
      sessionId: "sess_456",
      status: "error",
      detail: "rate_limited",
    });
    expect(text).toContain("🔴");
    expect(text).toContain("hit an error");
    expect(text).toContain("rate_limited");
  });

  it("renders a terminated status with a neutral marker", () => {
    const text = formatSessionNotifyComment({ sessionId: "sess_789", status: "terminated" });
    expect(text).toContain("⚪");
    expect(text).toContain("was terminated");
  });
});

describe("postSessionStatusComment", () => {
  it("posts the formatted comment to the configured issue via the installation token", async () => {
    const http = new FakeHttpClient();
    http.respondWith({
      status: 201,
      headers: {},
      body: JSON.stringify({ id: 42, html_url: "https://github.com/acme/widgets/issues/7#issuecomment-42" }),
    });
    const client = new GitHubApiClient(http);

    const result = await postSessionStatusComment(
      client,
      "ghs_installation_token",
      { owner: "acme", repo: "widgets", issueNumber: 7 },
      { sessionId: "sess_1", status: "idle" },
    );

    expect(result).toEqual({
      id: 42,
      htmlUrl: "https://github.com/acme/widgets/issues/7#issuecomment-42",
    });
    expect(http.calls).toHaveLength(1);
    const call = http.calls[0];
    expect(call.method).toBe("POST");
    expect(call.url).toBe("https://api.github.com/repos/acme/widgets/issues/7/comments");
    expect(call.headers?.authorization).toBe("Bearer ghs_installation_token");
    const body = JSON.parse(call.body ?? "{}") as { body: string };
    expect(body.body).toContain("sess_1");
  });

  it("throws GitHubApiError on a non-201 response", async () => {
    const http = new FakeHttpClient();
    http.respondWith({ status: 404, headers: {}, body: JSON.stringify({ message: "Not Found" }) });
    const client = new GitHubApiClient(http);

    await expect(
      postSessionStatusComment(
        client,
        "ghs_token",
        { owner: "acme", repo: "widgets", issueNumber: 999 },
        { sessionId: "sess_2", status: "error" },
      ),
    ).rejects.toThrow(/HTTP 404/);
  });
});
