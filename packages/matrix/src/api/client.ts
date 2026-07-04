// Minimal Matrix Client-Server API client — just enough to send a message
// as a bot into a room. No sync, no login — the bot's access token and
// homeserver are supplied by the caller (resolved from a vault credential),
// same shape as GitHubApiClient/SlackApiClient taking tokens directly.
//
// Spec: https://spec.matrix.org/latest/client-server-api/#put_matrixclientv3roomsroomidsendeventtypetxnid

import type { HttpClient } from "@duyet/oma-integrations-core";
import { DEFAULT_MATRIX_MSGTYPE } from "../config";

export class MatrixApiError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number,
  ) {
    super(message);
    this.name = "MatrixApiError";
  }
}

export interface SendMessageResult {
  eventId: string;
}

export class MatrixApiClient {
  constructor(private readonly http: HttpClient) {}

  /**
   * `PUT /_matrix/client/v3/rooms/{roomId}/send/m.room.message/{txnId}` —
   * send a plain-text message to a room as the bot identified by
   * `accessToken`. `txnId` defaults to a random UUID; pass an explicit one
   * for idempotent retries (Matrix dedupes on transaction id per-device).
   */
  async sendMessage(
    accessToken: string,
    homeserverUrl: string,
    roomId: string,
    body: string,
    opts?: { msgtype?: string; txnId?: string },
  ): Promise<SendMessageResult> {
    const txnId = opts?.txnId ?? crypto.randomUUID();
    const base = homeserverUrl.replace(/\/+$/, "");
    const url = `${base}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`;
    const res = await this.http.fetch({
      method: "PUT",
      url,
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        msgtype: opts?.msgtype ?? DEFAULT_MATRIX_MSGTYPE,
        body,
      }),
    });
    if (res.status < 200 || res.status >= 300) {
      throw new MatrixApiError(
        `PUT .../send/m.room.message/${txnId}: HTTP ${res.status} ${res.body.slice(0, 200)}`,
        res.status,
      );
    }
    const parsed = JSON.parse(res.body) as { event_id?: string };
    if (typeof parsed.event_id !== "string") {
      throw new MatrixApiError(
        `PUT .../send/m.room.message/${txnId}: missing event_id in response: ${res.body.slice(0, 200)}`,
        res.status,
      );
    }
    return { eventId: parsed.event_id };
  }
}
