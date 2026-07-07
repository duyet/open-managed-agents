import { describe, expect, it, vi } from "vitest";
import { FakeHttpClient } from "@duyet/oma-integrations-core/test-fakes";
import type { NotificationTarget } from "@duyet/oma-api-types";
import { dispatchSessionNotifications } from "./notify-dispatch";

const githubTarget: NotificationTarget = {
  type: "github_comment",
  credential_id: "cred_gh",
  owner: "acme",
  repo: "widgets",
  issue_number: 7,
};
const slackTarget: NotificationTarget = {
  type: "slack_message",
  credential_id: "cred_slack",
  channel: "C123",
};
const matrixTarget: NotificationTarget = {
  type: "matrix_message",
  credential_id: "cred_matrix",
  homeserver_url: "https://matrix.example.com",
  room_id: "!room:example.com",
};

const event = { sessionId: "sess_1", status: "idle" as const, agentName: "Reviewer" };

function tokenResolverFor(map: Record<string, string | null>) {
  return async (credentialId?: string) => (credentialId ? map[credentialId] ?? null : null);
}

describe("dispatchSessionNotifications", () => {
  it("dispatches to all three provider types concurrently", async () => {
    // Route the canned response by target URL rather than call order — the
    // three dispatches run concurrently via Promise.allSettled, so the
    // order fetch() actually fires in is not guaranteed to match target order.
    const calls: Array<{ method: string; url: string; headers?: Record<string, string>; body?: string }> = [];
    const httpClient = {
      fetch: async (req: { method: string; url: string; headers?: Record<string, string>; body?: string }) => {
        calls.push(req);
        if (req.url.includes("api.github.com")) {
          return { status: 201, headers: {}, body: JSON.stringify({ id: 1, html_url: "https://github.com/acme/widgets/issues/7#issuecomment-1" }) };
        }
        if (req.url.includes("slack.com")) {
          return { status: 200, headers: {}, body: JSON.stringify({ ok: true, channel: "C123", ts: "1.1" }) };
        }
        return { status: 200, headers: {}, body: JSON.stringify({ event_id: "$abc:matrix.org" }) };
      },
    };

    await dispatchSessionNotifications(event, [githubTarget, slackTarget, matrixTarget], {
      resolveCredentialToken: tokenResolverFor({
        cred_gh: "ghs_token",
        cred_slack: "xoxb-token",
        cred_matrix: "mat_token",
      }),
      httpClient,
    });

    expect(calls).toHaveLength(3);
    const gh = calls.find((c) => c.url.includes("api.github.com"));
    const slack = calls.find((c) => c.url.includes("slack.com"));
    const matrix = calls.find((c) => c.url.includes("matrix.example.com"));
    expect(gh).toBeDefined();
    expect(gh?.headers?.authorization).toBe("Bearer ghs_token");
    expect(gh?.url).toBe("https://api.github.com/repos/acme/widgets/issues/7/comments");

    expect(slack).toBeDefined();
    expect(slack?.headers?.authorization).toBe("Bearer xoxb-token");
    expect(slack?.url).toBe("https://slack.com/api/chat.postMessage");
    const slackBody = JSON.parse(slack?.body ?? "{}") as { channel: string; text: string };
    expect(slackBody.channel).toBe("C123");

    expect(matrix).toBeDefined();
    expect(matrix?.headers?.authorization).toBe("Bearer mat_token");
    expect(matrix?.url).toContain("https://matrix.example.com/_matrix/client/v3/rooms/");
  });

  it("skips a target with no resolvable credential token, without throwing, and still dispatches the others", async () => {
    const calls: Array<{ url: string }> = [];
    const httpClient = {
      fetch: async (req: { url: string }) => {
        calls.push(req);
        if (req.url.includes("slack.com")) {
          return { status: 200, headers: {}, body: JSON.stringify({ ok: true, channel: "C123", ts: "1.1" }) };
        }
        return { status: 200, headers: {}, body: JSON.stringify({ event_id: "$abc:matrix.org" }) };
      },
    };
    const onError = vi.fn();

    await expect(
      dispatchSessionNotifications(event, [githubTarget, slackTarget, matrixTarget], {
        resolveCredentialToken: tokenResolverFor({
          cred_gh: null, // no token resolved for github
          cred_slack: "xoxb-token",
          cred_matrix: "mat_token",
        }),
        httpClient,
        onError,
      }),
    ).resolves.toBeUndefined();

    // github never reached the network — only slack + matrix fired.
    expect(calls).toHaveLength(2);
    expect(calls.some((c) => c.url.includes("api.github.com"))).toBe(false);
    expect(calls.some((c) => c.url.includes("slack.com"))).toBe(true);
    expect(calls.some((c) => c.url.includes("matrix.example.com"))).toBe(true);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBe(githubTarget);
  });

  it("skips a target whose provider call throws, calls onError, and still dispatches the others", async () => {
    const http = new FakeHttpClient();
    // Give matrix a bad response (403) so MatrixApiClient throws MatrixApiError,
    // while slack succeeds via the fallback response below. Route by URL
    // rather than relying on concurrent-call ordering.
    http.setFallback({ status: 200, headers: {}, body: JSON.stringify({ ok: true, channel: "C123", ts: "1.1" }) });
    const onError = vi.fn();

    await dispatchSessionNotifications(event, [slackTarget, matrixTarget], {
      resolveCredentialToken: tokenResolverFor({
        cred_slack: "xoxb-token",
        cred_matrix: "mat_token",
      }),
      httpClient: {
        fetch: async (req) => {
          if (req.url.includes("matrix.example.com")) {
            return { status: 403, headers: {}, body: JSON.stringify({ errcode: "M_FORBIDDEN" }) };
          }
          return http.fetch(req);
        },
      },
      onError,
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBe(matrixTarget);
    expect(onError.mock.calls[0][1]).toBeInstanceOf(Error);
    // slack still got its request in despite matrix failing.
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0].url).toBe("https://slack.com/api/chat.postMessage");
  });

  it("never throws even when every target fails", async () => {
    await expect(
      dispatchSessionNotifications(event, [githubTarget], {
        resolveCredentialToken: async () => {
          throw new Error("boom");
        },
        httpClient: new FakeHttpClient(),
      }),
    ).resolves.toBeUndefined();
  });

  it("is a no-op when there are no targets", async () => {
    const http = new FakeHttpClient();
    await dispatchSessionNotifications(event, [], { resolveCredentialToken: async () => null, httpClient: http });
    expect(http.calls).toHaveLength(0);
  });
});
