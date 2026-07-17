// Unit tests for BridgeRelaySandbox — the relay-backed SandboxExecutor that
// forwards sandbox ops to a paired `oma bridge daemon` over the RuntimeRoom
// Durable Object WebSocket. Covers: request/response correlation, the
// no-runtime-online error, the no-tenant error, and pending-op rejection on
// disconnect / destroy. Runs in the Workers pool so `WebSocketPair` is real.

import { describe, it, expect, afterEach } from "vitest";
import type { Env } from "@duyet/oma-shared";
import { BridgeRelaySandbox, pickOnlineRuntimeId } from "./bridge-relay";
import { SandboxProviderUnavailableError } from "./sandbox";

// Track every sandbox created so we can tear down its WS after each test —
// leaked-open sockets aggravate the miniflare worker-teardown flake.
const created: BridgeRelaySandbox[] = [];
function track(s: BridgeRelaySandbox): BridgeRelaySandbox {
  created.push(s);
  return s;
}
afterEach(async () => {
  for (const s of created.splice(0)) {
    try { await s.destroy(); } catch { /* best-effort */ }
  }
});

/** Minimal D1-shaped stub returning fixed rows for `.all()`. */
function fakeDb(rows: Array<{ id: string }>): Env["MAIN_DB"] {
  return {
    prepare: () => ({
      bind: () => ({
        all: async () => ({ results: rows }),
      }),
    }),
  } as unknown as Env["MAIN_DB"];
}

/**
 * Fake RUNTIME_ROOM namespace whose DO fetch upgrades to a WebSocket and runs
 * a scripted "daemon": `run(serverSide)` is invoked with the DO/daemon end of
 * the pair so a test can drive replies.
 */
function fakeRuntimeRoom(run: (server: WebSocket) => void): DurableObjectNamespace {
  return {
    idFromName: (n: string) => n as unknown as DurableObjectId,
    get: () => ({
      fetch: async () => {
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        (server as unknown as { accept(): void }).accept();
        run(server);
        return new Response(null, { status: 101, webSocket: client });
      },
    }),
  } as unknown as DurableObjectNamespace;
}

function envWith(opts: {
  rows?: Array<{ id: string }>;
  run?: (server: WebSocket) => void;
}): Env {
  return {
    MAIN_DB: fakeDb(opts.rows ?? [{ id: "rt_1" }]),
    RUNTIME_ROOM: opts.run ? fakeRuntimeRoom(opts.run) : undefined,
  } as unknown as Env;
}

/** A scripted daemon that acks the handshake and echoes exec output. */
function echoDaemon(server: WebSocket): void {
  server.send(JSON.stringify({ type: "attached", daemon_online: true }));
  server.addEventListener("message", (ev: MessageEvent) => {
    const m = JSON.parse(ev.data as string);
    if (m.type !== "sandbox.op") return;
    const result =
      m.op === "exec" ? { output: `ran:${m.command}` } :
      m.op === "readFile" ? { content: "hello" } :
      {};
    server.send(JSON.stringify({
      type: "sandbox.result",
      request_id: m.request_id,
      session_id: m.session_id,
      ok: true,
      result,
    }));
  });
}

describe("pickOnlineRuntimeId", () => {
  it("returns the first row's id", async () => {
    expect(await pickOnlineRuntimeId(fakeDb([{ id: "rt_9" }]), "t1")).toBe("rt_9");
  });
  it("returns null when no runtime is online", async () => {
    expect(await pickOnlineRuntimeId(fakeDb([]), "t1")).toBeNull();
  });
});

describe("BridgeRelaySandbox", () => {
  it("correlates an exec request to its result", async () => {
    const sandbox = track(new BridgeRelaySandbox(envWith({ run: echoDaemon }), "sess_1", "t1"));
    const out = await sandbox.exec("echo hi");
    expect(out).toBe("ran:echo hi");
  });

  it("multiplexes concurrent ops by request_id", async () => {
    const sandbox = track(new BridgeRelaySandbox(envWith({ run: echoDaemon }), "sess_1", "t1"));
    const [a, b] = await Promise.all([sandbox.exec("one"), sandbox.readFile("/workspace/x")]);
    expect(a).toBe("ran:one");
    expect(b).toBe("hello");
  });

  it("throws SandboxProviderUnavailableError when no runtime is online", async () => {
    const sandbox = track(new BridgeRelaySandbox(envWith({ rows: [], run: echoDaemon }), "sess_1", "t1"));
    await expect(sandbox.exec("echo hi")).rejects.toBeInstanceOf(SandboxProviderUnavailableError);
    await expect(sandbox.exec("echo hi")).rejects.toThrow(/bridge setup/);
  });

  it("throws SandboxProviderUnavailableError when the session has no tenant", async () => {
    const sandbox = track(new BridgeRelaySandbox(envWith({ run: echoDaemon }), "sess_1", ""));
    await expect(sandbox.exec("echo hi")).rejects.toBeInstanceOf(SandboxProviderUnavailableError);
  });

  it("fails when the daemon socket is not attached (daemon_online=false)", async () => {
    const sandbox = track(new BridgeRelaySandbox(
      envWith({ run: (s) => s.send(JSON.stringify({ type: "attached", daemon_online: false })) }),
      "sess_1",
      "t1",
    ));
    await expect(sandbox.exec("echo hi")).rejects.toBeInstanceOf(SandboxProviderUnavailableError);
  });

  it("rejects an in-flight op when the runtime WS closes", async () => {
    const sandbox = track(new BridgeRelaySandbox(
      envWith({
        run: (server) => {
          server.send(JSON.stringify({ type: "attached", daemon_online: true }));
          // Never reply; close after receiving the op.
          server.addEventListener("message", () => {
            setTimeout(() => (server as unknown as { close(): void }).close(), 5);
          });
        },
      }),
      "sess_1",
      "t1",
    ));
    await expect(sandbox.exec("echo hi")).rejects.toThrow(/closed|error/i);
  });

  it("propagates a daemon error result as a rejected op", async () => {
    const sandbox = track(new BridgeRelaySandbox(
      envWith({
        run: (server) => {
          server.send(JSON.stringify({ type: "attached", daemon_online: true }));
          server.addEventListener("message", (ev: MessageEvent) => {
            const m = JSON.parse(ev.data as string);
            server.send(JSON.stringify({
              type: "sandbox.result",
              request_id: m.request_id,
              session_id: m.session_id,
              ok: false,
              error: "boom",
            }));
          });
        },
      }),
      "sess_1",
      "t1",
    ));
    await expect(sandbox.exec("echo hi")).rejects.toThrow(/boom/);
  });
});
