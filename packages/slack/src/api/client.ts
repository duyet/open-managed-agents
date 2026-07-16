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

/** A Block Kit block. Kept as an opaque record — see blocks.ts for builders. */
export type SlackBlock = Record<string, unknown>;

export interface PostMessageInput {
  channel: string;
  /** Fallback/notification text. Always send something so mobile pushes read. */
  text: string;
  /** Optional Block Kit blocks for rich rendering. */
  blocks?: SlackBlock[];
  /** Thread parent ts — replies stay threaded, never top-level. */
  threadTs?: string;
}

export interface UploadFileInput {
  channel: string;
  threadTs?: string;
  filename: string;
  /**
   * File content as text (CSV, diff, JSON, markdown, …). The injected
   * `HttpClient` port only carries string bodies, so binary uploads aren't
   * supported through this path — the agent's text artifacts are.
   */
  content: string;
  /** Optional human title (defaults to filename). */
  title?: string;
  /** Optional initial comment posted alongside the file. */
  initialComment?: string;
}

export interface UploadFileResult {
  fileId: string;
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

  /**
   * `chat.postMessage` with Block Kit support and threading. Superset of
   * {@link postMessage} used by the thread reporter — always threads replies
   * under `threadTs` when provided so agent output never lands top-level.
   */
  async postMessageBlocks(token: string, input: PostMessageInput): Promise<PostMessageResult> {
    const body: Record<string, unknown> = { channel: input.channel, text: input.text };
    if (input.blocks) body.blocks = input.blocks;
    if (input.threadTs) body.thread_ts = input.threadTs;
    const res = await this.http.fetch({
      method: "POST",
      url: `${SLACK_API_BASE}/chat.postMessage`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    if (parsed.ok !== true) {
      const err = typeof parsed.error === "string" ? parsed.error : "unknown_error";
      throw new SlackApiError("chat.postMessage", err, res.status);
    }
    return {
      channel: typeof parsed.channel === "string" ? parsed.channel : input.channel,
      ts: typeof parsed.ts === "string" ? parsed.ts : "",
    };
  }

  /**
   * `chat.update` — edit a previously posted message in place. Used to turn a
   * single "thinking…" status message into a live progress indicator without
   * spamming the thread with new messages.
   */
  async updateMessage(
    token: string,
    channel: string,
    ts: string,
    input: { text: string; blocks?: SlackBlock[] },
  ): Promise<PostMessageResult> {
    const body: Record<string, unknown> = { channel, ts, text: input.text };
    if (input.blocks) body.blocks = input.blocks;
    const res = await this.http.fetch({
      method: "POST",
      url: `${SLACK_API_BASE}/chat.update`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    if (parsed.ok !== true) {
      const err = typeof parsed.error === "string" ? parsed.error : "unknown_error";
      throw new SlackApiError("chat.update", err, res.status);
    }
    return {
      channel: typeof parsed.channel === "string" ? parsed.channel : channel,
      ts: typeof parsed.ts === "string" ? parsed.ts : ts,
    };
  }

  /**
   * Upload a file to a thread using Slack's external-upload flow (the modern
   * replacement for the removed `files.upload`):
   *
   *   1. `files.getUploadURLExternal` → { upload_url, file_id }
   *   2. PUT the raw bytes to `upload_url`
   *   3. `files.completeUploadExternal` → shares the file into channel/thread
   *
   * Used to attach agent-generated artifacts (CSV, PNG, PDF, diffs) to the
   * conversation.
   */
  async uploadFile(token: string, input: UploadFileInput): Promise<UploadFileResult> {
    // Step 1: reserve an upload URL + file id.
    const byteLength = new TextEncoder().encode(input.content).byteLength;
    const params = new URLSearchParams({
      filename: input.filename,
      length: String(byteLength),
    });
    const reserveRes = await this.http.fetch({
      method: "POST",
      url: `${SLACK_API_BASE}/files.getUploadURLExternal`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
    const reserve = JSON.parse(reserveRes.body) as Record<string, unknown>;
    if (reserve.ok !== true) {
      const err = typeof reserve.error === "string" ? reserve.error : "unknown_error";
      throw new SlackApiError("files.getUploadURLExternal", err, reserveRes.status);
    }
    const uploadUrl = typeof reserve.upload_url === "string" ? reserve.upload_url : "";
    const fileId = typeof reserve.file_id === "string" ? reserve.file_id : "";
    if (!uploadUrl || !fileId) {
      throw new SlackApiError("files.getUploadURLExternal", "missing_upload_url", reserveRes.status);
    }

    // Step 2: PUT the bytes to the reserved URL.
    await this.http.fetch({
      method: "POST",
      url: uploadUrl,
      headers: { "content-type": "application/octet-stream" },
      body: input.content,
      // NOTE: string body per the HttpClient port contract.
    });

    // Step 3: complete the upload, sharing into the channel/thread.
    const completeBody: Record<string, unknown> = {
      files: [{ id: fileId, title: input.title ?? input.filename }],
      channel_id: input.channel,
    };
    if (input.threadTs) completeBody.thread_ts = input.threadTs;
    if (input.initialComment) completeBody.initial_comment = input.initialComment;
    const completeRes = await this.http.fetch({
      method: "POST",
      url: `${SLACK_API_BASE}/files.completeUploadExternal`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(completeBody),
    });
    const complete = JSON.parse(completeRes.body) as Record<string, unknown>;
    if (complete.ok !== true) {
      const err = typeof complete.error === "string" ? complete.error : "unknown_error";
      throw new SlackApiError("files.completeUploadExternal", err, completeRes.status);
    }
    return { fileId };
  }
}
