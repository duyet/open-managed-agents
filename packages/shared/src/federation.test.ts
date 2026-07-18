// Unit tests for the cross-instance federation client (issue #132). Drives
// resolve + delegate against a faked remote OMA instance — no real network,
// no real timers (sleep is injected).

import { describe, it, expect } from "vitest";
import {
  buildLabeledCrypto,
  FEDERATION_CRYPTO_LABEL,
} from "./credential-crypto";
import {
  delegateToRemoteAgent,
  federationKvKey,
  listRemoteAgents,
  resolveFederationInstance,
  type FederationInstanceRow,
  type FetchLike,
} from "./federation";

const SECRET = "test-root-secret-abc";

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status < 400,
    status,
    async text() {
      return JSON.stringify(body);
    },
    async json() {
      return body;
    },
  };
}

class FakeKv {
  store = new Map<string, string>();
  async get(key: string) {
    return this.store.get(key) ?? null;
  }
}

describe("resolveFederationInstance", () => {
  it("decrypts the stored api key", async () => {
    const crypto = buildLabeledCrypto(SECRET, FEDERATION_CRYPTO_LABEL);
    const kv = new FakeKv();
    const row: FederationInstanceRow = {
      id: "fed_1",
      tenant_id: "tn",
      name: "peer",
      base_url: "https://peer.example.com",
      api_key_enc: await crypto.encrypt("omak_secret"),
      created_at: Date.now(),
    };
    kv.store.set(federationKvKey("tn", "fed_1"), JSON.stringify(row));

    const target = await resolveFederationInstance(kv, crypto, "tn", "fed_1");
    expect(target).toEqual({ base_url: "https://peer.example.com", api_key: "omak_secret" });
  });

  it("returns null on a miss", async () => {
    const crypto = buildLabeledCrypto(SECRET, FEDERATION_CRYPTO_LABEL);
    const target = await resolveFederationInstance(new FakeKv(), crypto, "tn", "nope");
    expect(target).toBeNull();
  });

  it("surfaces an undecryptable key as no key rather than throwing", async () => {
    const kv = new FakeKv();
    const wrongKey = buildLabeledCrypto("different-secret", FEDERATION_CRYPTO_LABEL);
    const row: FederationInstanceRow = {
      id: "fed_1",
      tenant_id: "tn",
      name: "peer",
      base_url: "https://peer.example.com",
      api_key_enc: await wrongKey.encrypt("omak_secret"),
      created_at: Date.now(),
    };
    kv.store.set(federationKvKey("tn", "fed_1"), JSON.stringify(row));

    const crypto = buildLabeledCrypto(SECRET, FEDERATION_CRYPTO_LABEL);
    const target = await resolveFederationInstance(kv, crypto, "tn", "fed_1");
    expect(target).toEqual({ base_url: "https://peer.example.com", api_key: undefined });
  });
});

describe("listRemoteAgents", () => {
  it("returns the remote agent list and sends the api key", async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push(url);
      expect(init?.headers?.["x-api-key"]).toBe("omak_k");
      return jsonResponse({ data: [{ id: "agent_a", name: "A" }] });
    };
    const agents = await listRemoteAgents(
      { base_url: "https://peer.example.com", api_key: "omak_k" },
      fetchImpl,
    );
    expect(agents).toEqual([{ id: "agent_a", name: "A" }]);
    expect(calls[0]).toBe("https://peer.example.com/v1/agents");
  });

  it("throws on a non-ok response", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ error: "nope" }, 401);
    await expect(
      listRemoteAgents({ base_url: "https://peer.example.com" }, fetchImpl),
    ).rejects.toThrow(/401/);
  });
});

describe("delegateToRemoteAgent", () => {
  const noSleep = async () => {};

  it("creates a session, posts the message, polls to idle, returns text", async () => {
    const seen: Array<{ method: string; url: string; body?: string }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      seen.push({ method: init?.method ?? "GET", url, body: init?.body });
      if (url.endsWith("/v1/sessions") && init?.method === "POST") {
        return jsonResponse({ id: "sess_remote" }, 201);
      }
      if (url.endsWith("/sessions/sess_remote/events") && init?.method === "POST") {
        return jsonResponse({ ok: true });
      }
      if (url.includes("/sessions/sess_remote/events?")) {
        return jsonResponse({
          data: [
            { seq: 1, type: "user.message", content: [] },
            { seq: 2, type: "agent.message", content: [{ type: "text", text: "hello from remote" }] },
            { seq: 3, type: "session.status_idle", content: [] },
          ],
        });
      }
      throw new Error(`unexpected ${init?.method} ${url}`);
    };

    const res = await delegateToRemoteAgent(
      { base_url: "https://peer.example.com", api_key: "omak_k" },
      { remoteAgentId: "agent_a", message: "hi", fetchImpl, sleep: noSleep },
    );
    expect(res.text).toBe("hello from remote");
    expect(res.remote_session_id).toBe("sess_remote");
    // create body carries the remote agent id.
    const create = seen.find((s) => s.url.endsWith("/v1/sessions"));
    expect(JSON.parse(create!.body!).agent).toBe("agent_a");
  });

  it("throws when the remote emits session.error", async () => {
    const fetchImpl: FetchLike = async (url, init) => {
      if (url.endsWith("/v1/sessions") && init?.method === "POST") {
        return jsonResponse({ id: "sess_remote" }, 201);
      }
      if (url.endsWith("/events") && init?.method === "POST") {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({
        data: [{ seq: 1, type: "session.error", content: [{ type: "text", text: "boom" }] }],
      });
    };
    await expect(
      delegateToRemoteAgent(
        { base_url: "https://peer.example.com" },
        { remoteAgentId: "agent_a", message: "hi", fetchImpl, sleep: noSleep },
      ),
    ).rejects.toThrow(/boom/);
  });

  it("throws when session create fails", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ error: "forbidden" }, 403);
    await expect(
      delegateToRemoteAgent(
        { base_url: "https://peer.example.com" },
        { remoteAgentId: "agent_a", message: "hi", fetchImpl, sleep: noSleep },
      ),
    ).rejects.toThrow(/create failed \(403\)/);
  });

  it("times out if the remote never reaches idle", async () => {
    const fetchImpl: FetchLike = async (url, init) => {
      if (url.endsWith("/v1/sessions") && init?.method === "POST") {
        return jsonResponse({ id: "sess_remote" }, 201);
      }
      if (url.endsWith("/events") && init?.method === "POST") {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ data: [{ seq: 1, type: "agent.thinking", content: [] }] });
    };
    await expect(
      delegateToRemoteAgent(
        { base_url: "https://peer.example.com" },
        {
          remoteAgentId: "agent_a",
          message: "hi",
          fetchImpl,
          sleep: noSleep,
          timeoutMs: -1, // already past the deadline on the first poll
        },
      ),
    ).rejects.toThrow(/timed out/);
  });
});
