// @ts-nocheck
//
// SessionDO session-metadata mirroring — issue #222.
//
// Bug: maybeFireSessionNotifications read `this.state.metadata`, a field
// SessionState never declared and /init never wrote — so webhook notify
// envelopes always omitted publication_id/end_user_id. PR #206 hit the same
// gap for per_1k_tokens metering and worked around it with a per-session row
// lookup + bespoke `metering_wallet` state cache.
//
// The fix: thread `metadata` through the DO /init contract (SessionInitParams
// → SessionState.metadata), with resolveMetadata() (apps/agent/src/runtime/
// resolve-session-metadata.ts) providing a one-time row-lookup fallback +
// cache for sessions whose DO state predates the mirror. Both
// maybeFireSessionNotifications and maybeMeterTurn now share that single
// resolution path.
//
// These tests reach into a live SessionDO the same way
// test/integration/recovery-do.test.ts does (runInDurableObject +
// env.SESSION_DO.idFromName) — real DO, no mocking of SessionDO itself.

import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { registerHarness } from "../../apps/agent/src/harness/registry";
import type { HarnessInterface, HarnessContext } from "../../apps/agent/src/harness/interface";
import { walletFromMetadata } from "../../apps/agent/src/runtime/resolve-session-metadata";

class NoopHarness implements HarnessInterface {
  async run(_ctx: HarnessContext): Promise<void> {
    /* no LLM */
  }
}
registerHarness("noop-session-metadata", () => new NoopHarness());

const H = { "x-api-key": "test-key", "Content-Type": "application/json" };
function api(path: string, init?: RequestInit) {
  return exports.default.fetch(new Request(`http://localhost${path}`, init));
}
function post(path: string, body: unknown) {
  return api(path, { method: "POST", headers: H, body: JSON.stringify(body) });
}

/** Create an agent + environment, returning both rows. `notify` (when given)
 *  is nested under `_oma.notify` — matches the wire contract in
 *  packages/http-routes/src/agents/index.ts (`raw._oma?.notify`). */
async function newAgentAndEnv(opts: { name: string; notify?: unknown[] } ) {
  const a = await post("/v1/agents", {
    name: opts.name,
    model: "claude-sonnet-4-6",
    harness: "noop-session-metadata",
    ...(opts.notify ? { _oma: { notify: opts.notify } } : {}),
  });
  const agent = await a.json();
  const e = await post("/v1/environments", { name: `${opts.name}-env`, config: { type: "cloud" } });
  const environment = await e.json();
  return { agent, environment };
}

/** Create a real session via the full HTTP flow (POST /v1/sessions), which
 *  drives router.init → the DO's real /init handler — same production path
 *  every session takes. */
async function newSession(agentId: string, environmentId: string): Promise<string> {
  const s = await post("/v1/sessions", { agent: agentId, environment_id: environmentId });
  const session = await s.json();
  return session.id;
}

describe("SessionDO session metadata (issue #222)", () => {
  it("PUT /init mirrors a metadata bag verbatim into DO state", async () => {
    const { agent, environment } = await newAgentAndEnv({ name: "MetaInitTest" });
    const sessionId = `sess_metainit_${Math.random().toString(36).slice(2, 10)}`;
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));

    await stub.fetch(
      new Request("https://internal/init", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent_id: agent.id,
          environment_id: environment.id,
          title: "",
          session_id: sessionId,
          tenant_id: "default",
          metadata: { publication_id: "pub_1", end_user_id: "eu_1" },
        }),
      }),
    );

    const metadata = await runInDurableObject(stub, (instance) => (instance as { _state: { metadata?: unknown } })._state.metadata);
    expect(metadata).toEqual({ publication_id: "pub_1", end_user_id: "eu_1" });
  });

  it("PUT /init without a metadata param still sets state.metadata to {} (not undefined) — marks the session as post-#222", async () => {
    const { agent, environment } = await newAgentAndEnv({ name: "MetaInitEmptyTest" });
    const sessionId = `sess_metaempty_${Math.random().toString(36).slice(2, 10)}`;
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));

    await stub.fetch(
      new Request("https://internal/init", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent_id: agent.id,
          environment_id: environment.id,
          title: "",
          session_id: sessionId,
          tenant_id: "default",
          // no metadata field at all
        }),
      }),
    );

    const metadata = await runInDurableObject(stub, (instance) => (instance as { _state: { metadata?: unknown } })._state.metadata);
    // {} (resolved, authoritative) — NOT undefined (which would mean
    // "legacy, needs a row-lookup fallback").
    expect(metadata).toEqual({});
    expect(metadata).not.toBeUndefined();
  });

  it("legacy session (state.metadata undefined) falls back to a row lookup, then caches the result", async () => {
    const { agent, environment } = await newAgentAndEnv({ name: "MetaLegacyTest" });
    const sessionId = await newSession(agent.id, environment.id);
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));

    // Row now carries the wallet identity (the existing, already-working
    // POST /:id metadata-update path — unrelated to this fix).
    await post(`/v1/sessions/${sessionId}`, {
      metadata: { publication_id: "pub_legacy", end_user_id: "eu_legacy" },
    });

    // Simulate "this DO's state predates the #222 mirror": /init already ran
    // above (via newSession) and set state.metadata to {} — force it back to
    // undefined so resolveMetadata() takes the fallback branch.
    await runInDurableObject(stub, (instance) => {
      (instance as { _state: { metadata?: unknown } })._state.metadata = undefined;
    });

    const resolved = await runInDurableObject(stub, async (instance) => {
      return (instance as unknown as { resolveMetadata: () => Promise<Record<string, unknown>> }).resolveMetadata();
    });
    expect(resolved).toEqual({ publication_id: "pub_legacy", end_user_id: "eu_legacy" });

    // Cached back into state — no longer undefined.
    const cachedAfter = await runInDurableObject(stub, (instance) => (instance as { _state: { metadata?: unknown } })._state.metadata);
    expect(cachedAfter).toEqual({ publication_id: "pub_legacy", end_user_id: "eu_legacy" });

    // Prove it's actually cached (not re-read every call): change the row to
    // a different value, call resolveMetadata() again, and confirm it still
    // returns the ORIGINAL resolved value.
    await post(`/v1/sessions/${sessionId}`, {
      metadata: { publication_id: "pub_changed", end_user_id: "eu_changed" },
    });
    const resolvedAgain = await runInDurableObject(stub, async (instance) => {
      return (instance as unknown as { resolveMetadata: () => Promise<Record<string, unknown>> }).resolveMetadata();
    });
    expect(resolvedAgain).toEqual({ publication_id: "pub_legacy", end_user_id: "eu_legacy" });
  });

  it("a session with no metadata at all resolves to {} via the fallback (no wallet, no crash)", async () => {
    const { agent, environment } = await newAgentAndEnv({ name: "MetaNoneTest" });
    const sessionId = await newSession(agent.id, environment.id);
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));

    await runInDurableObject(stub, (instance) => {
      (instance as { _state: { metadata?: unknown } })._state.metadata = undefined;
    });

    const resolved = await runInDurableObject(stub, async (instance) => {
      return (instance as unknown as { resolveMetadata: () => Promise<Record<string, unknown>> }).resolveMetadata();
    });
    expect(resolved).toEqual({});
    expect(walletFromMetadata(resolved)).toBeNull();
  });

  it("resolveMetadata()-derived wallet resolution matches the pre-refactor shape (metering unaffected)", async () => {
    const { agent, environment } = await newAgentAndEnv({ name: "MetaWalletTest" });
    const sessionId = `sess_wallet_${Math.random().toString(36).slice(2, 10)}`;
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));

    await stub.fetch(
      new Request("https://internal/init", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent_id: agent.id,
          environment_id: environment.id,
          title: "",
          session_id: sessionId,
          tenant_id: "default",
          metadata: { publication_id: "pub_wallet", end_user_id: "eu_wallet" },
        }),
      }),
    );

    const wallet = await runInDurableObject(stub, async (instance) => {
      const meta = await (instance as unknown as { resolveMetadata: () => Promise<Record<string, unknown>> }).resolveMetadata();
      return walletFromMetadata(meta);
    });
    expect(wallet).toEqual({ publication_id: "pub_wallet", end_user_id: "eu_wallet" });
  });

  it("session.status_idle fires a webhook notify envelope carrying publication_id/end_user_id from resolved metadata", async () => {
    const { agent, environment } = await newAgentAndEnv({
      name: "MetaWebhookTest",
      notify: [{ type: "webhook", url: "https://hooks.example.com/meta-e2e" }],
    });
    const sessionId = `sess_webhook_${Math.random().toString(36).slice(2, 10)}`;
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));

    await stub.fetch(
      new Request("https://internal/init", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent_id: agent.id,
          environment_id: environment.id,
          title: "",
          session_id: sessionId,
          tenant_id: "default",
          metadata: { publication_id: "pub_e2e", end_user_id: "eu_e2e" },
        }),
      }),
    );

    const calls: Array<{ url: string; body: string }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: String(init?.body ?? "") });
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    try {
      await runInDurableObject(stub, (instance) => {
        (instance as unknown as { broadcastEvent: (e: unknown) => void }).broadcastEvent({
          type: "session.status_idle",
          stop_reason: { type: "end_turn" },
        });
      });
      // maybeFireSessionNotifications is fire-and-forget (detached IIFE).
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://hooks.example.com/meta-e2e");
    const payload = JSON.parse(calls[0].body) as Record<string, unknown>;
    expect(payload.publication_id).toBe("pub_e2e");
    expect(payload.end_user_id).toBe("eu_e2e");
    expect(payload.session_id).toBe(sessionId);
    expect(payload.status).toBe("idle");
  });
});
