// Cross-instance federation (issue #132).
//
// Lets one OMA instance delegate a task to an agent running on ANOTHER OMA
// instance. The building blocks:
//
//   1. A tenant-level registry of remote instances (`fed_*`), stored in KV
//      exactly like the MCP server registry (packages/http-routes/
//      src/mcp-servers.ts). Each row records the remote base URL + an
//      encrypted API key (AES-256-GCM under FEDERATION_CRYPTO_LABEL).
//   2. `resolveFederationInstance` — reads a row, decrypts the key. Used by
//      the delegation executor (Node: directly; CF: via the
//      `env.MAIN_MCP.resolveFederationTarget` RPC, since the agent DO has no
//      KV/secret access).
//   3. A thin HTTP client that drives the remote instance's public REST API:
//      create a session, post a user.message, poll the event log until the
//      remote reaches idle, and return the remote agent's text response.
//
// The client is deliberately transport-simple (create → post → poll) so it is
// trivially unit-testable with a faked `fetch`, and works identically on
// Workers and Node. The remote instance is just another OMA speaking the same
// REST surface — federation is instance-to-instance, authenticated with a
// tenant API key stored on the calling side.

import type { CredentialBlobCrypto } from "./credential-crypto";

/** KV storage row for a registered remote OMA instance. The plaintext
 *  `api_key` never lives here — `api_key_enc` is the AES-GCM ciphertext. */
export interface FederationInstanceRow {
  id: string;
  tenant_id: string;
  name: string;
  base_url: string;
  /** AES-256-GCM ciphertext of the remote API key (base64url iv||ct). */
  api_key_enc?: string;
  description?: string;
  created_at: number;
  updated_at?: number;
}

/** KV key convention — mirrors `mcp_registry:<tenant>:<id>`. */
export const federationKvKey = (tenantId: string, id: string) =>
  `federation:${tenantId}:${id}`;

export const federationKvPrefix = (tenantId: string) => `federation:${tenantId}:`;

/** Minimal KV surface both runtimes' KvStore satisfies. */
export interface FederationKvLike {
  get(key: string): Promise<string | null>;
}

/**
 * Resolve a registered remote instance for a tenant: base URL + decrypted API
 * key. Returns null on miss / malformed row. Never throws on a bad ciphertext
 * — the caller treats a null as "not federated / not resolvable".
 */
export async function resolveFederationInstance(
  kv: FederationKvLike,
  crypto: CredentialBlobCrypto,
  tenantId: string,
  instanceId: string,
): Promise<{ base_url: string; api_key?: string } | null> {
  const raw = await kv.get(federationKvKey(tenantId, instanceId)).catch(() => null);
  if (!raw) return null;
  let row: FederationInstanceRow;
  try {
    row = JSON.parse(raw) as FederationInstanceRow;
  } catch {
    return null;
  }
  if (!row.base_url) return null;
  let api_key: string | undefined;
  if (row.api_key_enc) {
    try {
      api_key = await crypto.decrypt(row.api_key_enc);
    } catch {
      // A key that can't be decrypted (e.g. rotated PLATFORM_ROOT_SECRET) is
      // surfaced as "no key" — the delegation then fails loud at the remote
      // with a 401 rather than silently using stale bytes.
      api_key = undefined;
    }
  }
  return { base_url: row.base_url, api_key };
}

// ── Remote HTTP client ────────────────────────────────────────────────────

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

export interface RemoteInstanceTarget {
  base_url: string;
  api_key?: string;
}

export interface RemoteDelegateOptions {
  remoteAgentId: string;
  message: string;
  remoteEnvironmentId?: string;
  /** Overall wall-clock budget for the remote turn (create + poll). */
  timeoutMs?: number;
  /** Poll interval while waiting for the remote to reach idle. */
  pollIntervalMs?: number;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
  /** Injected for tests; defaults to a real setTimeout sleep. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 1_500;

function apiBase(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function authHeaders(apiKey?: string): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) h["x-api-key"] = apiKey;
  return h;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** List the agents available on a remote instance — used by the registry's
 *  connectivity-probe route so an operator can pick a `remote_agent_id`. */
export async function listRemoteAgents(
  target: RemoteInstanceTarget,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<Array<{ id: string; name?: string }>> {
  const res = await fetchImpl(`${apiBase(target.base_url)}/agents`, {
    method: "GET",
    headers: authHeaders(target.api_key),
  });
  if (!res.ok) {
    throw new Error(`remote /agents returned ${res.status}`);
  }
  const body = (await res.json()) as { data?: Array<{ id: string; name?: string }> } | unknown;
  const data = (body as { data?: Array<{ id: string; name?: string }> })?.data;
  return Array.isArray(data) ? data : [];
}

/** Extract concatenated text from a remote `agent.message` event's content. */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        const block = b as { type?: string; text?: string };
        return block?.type === "text" && typeof block.text === "string" ? block.text : "";
      })
      .filter(Boolean)
      .join("");
  }
  return "";
}

/**
 * Delegate a single task to an agent on a remote OMA instance and return its
 * text response. Creates a fresh remote session, posts the message, and polls
 * the remote event log until it reaches `session.status_idle` (or the timeout
 * elapses). Throws on any transport / remote error so the caller can surface
 * it as a tool error / `success: false`.
 */
export async function delegateToRemoteAgent(
  target: RemoteInstanceTarget,
  opts: RemoteDelegateOptions,
): Promise<{ text: string; remote_session_id: string }> {
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const sleep = opts.sleep ?? defaultSleep;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const base = apiBase(target.base_url);
  const headers = authHeaders(target.api_key);
  const deadline = Date.now() + timeoutMs;

  // 1. Create the remote session.
  const createRes = await fetchImpl(`${base}/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      agent: opts.remoteAgentId,
      ...(opts.remoteEnvironmentId ? { environment_id: opts.remoteEnvironmentId } : {}),
      metadata: { federation: { origin: "callable_agent" } },
    }),
  });
  if (!createRes.ok) {
    throw new Error(
      `remote session create failed (${createRes.status}): ${(await createRes.text()).slice(0, 300)}`,
    );
  }
  const created = (await createRes.json()) as { id?: string };
  const remoteSessionId = created?.id;
  if (!remoteSessionId) {
    throw new Error("remote session create returned no id");
  }

  // 2. Post the user message.
  const postRes = await fetchImpl(`${base}/sessions/${remoteSessionId}/events`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      events: [{ type: "user.message", content: [{ type: "text", text: opts.message }] }],
    }),
  });
  if (!postRes.ok) {
    throw new Error(
      `remote message post failed (${postRes.status}): ${(await postRes.text()).slice(0, 300)}`,
    );
  }

  // 3. Poll the event log until idle, collecting agent.message text emitted
  //    after our message. We track by seq so a slow first poll still captures
  //    everything from the start.
  let afterSeq = 0;
  const texts: string[] = [];
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error(`remote agent timed out after ${timeoutMs}ms (session ${remoteSessionId})`);
    }
    await sleep(pollIntervalMs);
    const evRes = await fetchImpl(
      `${base}/sessions/${remoteSessionId}/events?after_seq=${afterSeq}&order=asc`,
      { method: "GET", headers },
    );
    if (!evRes.ok) {
      throw new Error(`remote events poll failed (${evRes.status})`);
    }
    const page = (await evRes.json()) as {
      data?: Array<{ seq?: number; type?: string; content?: unknown }>;
    };
    const events = Array.isArray(page.data) ? page.data : [];
    let reachedIdle = false;
    for (const ev of events) {
      if (typeof ev.seq === "number" && ev.seq > afterSeq) afterSeq = ev.seq;
      if (ev.type === "agent.message") {
        const t = extractText(ev.content);
        if (t) texts.push(t);
      } else if (ev.type === "session.error") {
        const msg = extractText(ev.content) || "remote session.error";
        throw new Error(`remote agent error: ${msg.slice(0, 300)}`);
      } else if (ev.type === "session.status_idle") {
        reachedIdle = true;
      }
    }
    if (reachedIdle) break;
  }

  return { text: texts.join("\n\n"), remote_session_id: remoteSessionId };
}
