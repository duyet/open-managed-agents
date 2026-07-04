// Minimal Slack Web API client for the install flow.
//
// We don't need much from the Web API directly — the OAuth response already
// carries team.id, team.name, and bot_user_id. `auth.test` is useful as a
// post-install sanity check (verifies the token works against the API), and
// any other operations the bot performs at runtime go through `mcp.slack.com`
// via vault outbound injection rather than this client.

import type { HttpClient } from "@duyet/oma-integrations-core";

const SLACK_API_BASE = "https://slack.com/api";

export class SlackApiError extends Error {
  constructor(
    public readonly method: string,
    public readonly slackError: string,
    public readonly status: number,
  ) {
    super(`Slack ${method} failed: ${slackError} (HTTP ${status})`);
  }
}

export interface AuthTestResult {
  ok: boolean;
  url: string;
  team: string;
  user: string;
  team_id: string;
  user_id: string;
  bot_id?: string;
}

export interface PostMessageResult {
  channel: string;
  ts: string;
}

export class SlackApiClient {
  constructor(private readonly http: HttpClient) {}

  /**
   * Verify a token works and return the identity it's bound to.
   * Used post-OAuth to confirm install success and as a generic health check.
   * Pass either xoxb- or xoxp-.
   */
  async authTest(token: string): Promise<AuthTestResult> {
    const res = await this.http.fetch({
      method: "POST",
      url: `${SLACK_API_BASE}/auth.test`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "",
    });
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    if (parsed.ok !== true) {
      const err = typeof parsed.error === "string" ? parsed.error : "unknown_error";
      throw new SlackApiError("auth.test", err, res.status);
    }
    return {
      ok: true,
      url: typeof parsed.url === "string" ? parsed.url : "",
      team: typeof parsed.team === "string" ? parsed.team : "",
      user: typeof parsed.user === "string" ? parsed.user : "",
      team_id: typeof parsed.team_id === "string" ? parsed.team_id : "",
      user_id: typeof parsed.user_id === "string" ? parsed.user_id : "",
      bot_id: typeof parsed.bot_id === "string" ? parsed.bot_id : undefined,
    };
  }

  /**
   * `chat.postMessage` — post a message to a channel (or DM) as the bot.
   * Pass the bot (`xoxb-`) token. Used by notify.ts to post session-status
   * updates; the agent's own runtime traffic goes through `mcp.slack.com`
   * instead (see the module doc comment above).
   */
  async postMessage(token: string, channel: string, text: string): Promise<PostMessageResult> {
    const res = await this.http.fetch({
      method: "POST",
      url: `${SLACK_API_BASE}/chat.postMessage`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel, text }),
    });
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    if (parsed.ok !== true) {
      const err = typeof parsed.error === "string" ? parsed.error : "unknown_error";
      throw new SlackApiError("chat.postMessage", err, res.status);
    }
    return {
      channel: typeof parsed.channel === "string" ? parsed.channel : channel,
      ts: typeof parsed.ts === "string" ? parsed.ts : "",
    };
  }
}
