// Unit tests for AcpProxyHarness's model/reasoning-effort override plumbing
// (issue #269: the ACP proxy harness ignored AgentConfig.runtime_binding's
// `model` / `reasoning_effort` fields). Covers the harness's half of the
// wire: `binding.model` / `binding.reasoning_effort` must land verbatim on
// the outgoing `session.start` frame sent to RuntimeRoom (and be omitted
// entirely when unset, for wire-compat with daemons that predate #269).
// The daemon-side application of these fields against the spawned ACP
// child is covered separately in packages/acp-runtime/src/session.test.ts.
//
// Runs in the Workers pool so `WebSocketPair` is real — same pattern as
// bridge-relay.test.ts.

import { describe, it, expect, afterEach } from "vitest";
import type { AgentConfig, UserMessageEvent } from "@duyet/oma-shared";
import { AcpProxyHarness } from "./acp-proxy-loop";
import type { HarnessContext, HarnessRuntime } from "./interface";

/**
 * Fake RUNTIME_ROOM namespace whose DO fetch upgrades to a WebSocket and
 * runs a scripted "daemon": `run(serverSide)` drives replies and can
 * observe every frame the harness sends.
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

/** A scripted daemon: acks the attach handshake, then hands session.start
 *  frames to `onStart` before acking session.ready + completing the turn. */
function scriptedDaemon(onStart: (frame: Record<string, unknown>) => void) {
  return (server: WebSocket): void => {
    server.send(JSON.stringify({ type: "attached" }));
    server.addEventListener("message", (ev: MessageEvent) => {
      const m = JSON.parse(ev.data as string) as Record<string, unknown>;
      if (m.type === "session.start") {
        onStart(m);
        server.send(JSON.stringify({ type: "session.ready" }));
      } else if (m.type === "session.prompt") {
        server.send(JSON.stringify({ type: "session.complete", turn_id: m.turn_id }));
      }
    });
  };
}

function fakeUserMessage(text: string): UserMessageEvent {
  return {
    type: "user.message",
    id: "evt_1",
    created_at: new Date().toISOString(),
    content: [{ type: "text", text }],
  } as unknown as UserMessageEvent;
}

function fakeRuntime(): HarnessRuntime {
  return {
    broadcast: () => {},
  } as unknown as HarnessRuntime;
}

function agentWithBinding(runtime_binding: NonNullable<AgentConfig["runtime_binding"]>): AgentConfig {
  return {
    name: "test-acp-agent",
    model: "claude-sonnet-4-6",
    system: "",
    tools: [],
    harness: "acp-proxy",
    runtime_binding,
  } as unknown as AgentConfig;
}

async function runHarness(agent: AgentConfig, room: DurableObjectNamespace): Promise<void> {
  const harness = new AcpProxyHarness();
  const ctx = {
    agent,
    userMessage: fakeUserMessage("hello"),
    session_id: "sess_1",
    tenant_id: "tenant_1",
    tools: {},
    model: {} as never,
    systemPrompt: "",
    runtime: fakeRuntime(),
    env: { RUNTIME_ROOM: room } as unknown as HarnessContext["env"],
  } as unknown as HarnessContext;
  await harness.run(ctx);
}

describe("AcpProxyHarness — model/reasoning-effort override forwarding (#269)", () => {
  const sockets: WebSocket[] = [];
  afterEach(() => {
    for (const s of sockets.splice(0)) {
      try { s.close(); } catch { /* already closed */ }
    }
  });

  it("forwards both model and reasoning_effort on session.start when set", async () => {
    let captured: Record<string, unknown> | undefined;
    const room = fakeRuntimeRoom(scriptedDaemon((frame) => { captured = frame; }));

    await runHarness(
      agentWithBinding({
        runtime_id: "rt_1",
        acp_agent_id: "claude-acp",
        model: "claude-sonnet-4-6",
        reasoning_effort: "high",
      }),
      room,
    );

    expect(captured).toMatchObject({
      type: "session.start",
      agent_id: "claude-acp",
      model: "claude-sonnet-4-6",
      reasoning_effort: "high",
    });
  });

  it("omits model and reasoning_effort entirely when unset", async () => {
    let captured: Record<string, unknown> | undefined;
    const room = fakeRuntimeRoom(scriptedDaemon((frame) => { captured = frame; }));

    await runHarness(
      agentWithBinding({ runtime_id: "rt_1", acp_agent_id: "claude-acp" }),
      room,
    );

    expect(captured).toMatchObject({ type: "session.start", agent_id: "claude-acp" });
    expect(captured).not.toHaveProperty("model");
    expect(captured).not.toHaveProperty("reasoning_effort");
  });

  it("forwards only model when reasoning_effort is unset", async () => {
    let captured: Record<string, unknown> | undefined;
    const room = fakeRuntimeRoom(scriptedDaemon((frame) => { captured = frame; }));

    await runHarness(
      agentWithBinding({ runtime_id: "rt_1", acp_agent_id: "claude-acp", model: "claude-haiku-4-5" }),
      room,
    );

    expect(captured).toMatchObject({ model: "claude-haiku-4-5" });
    expect(captured).not.toHaveProperty("reasoning_effort");
  });
});

describe("AcpProxyHarness — local-agent-binding forwarding (working_dir/branch/worktree)", () => {
  const sockets: WebSocket[] = [];
  afterEach(() => {
    for (const s of sockets.splice(0)) {
      try { s.close(); } catch { /* already closed */ }
    }
  });

  it("forwards working_dir and branch on session.start when set", async () => {
    let captured: Record<string, unknown> | undefined;
    const room = fakeRuntimeRoom(scriptedDaemon((frame) => { captured = frame; }));

    await runHarness(
      agentWithBinding({
        runtime_id: "rt_1",
        acp_agent_id: "claude-acp",
        working_dir: "/Users/dev/projects/my-repo",
        branch: "feature/x",
      }),
      room,
    );

    expect(captured).toMatchObject({
      type: "session.start",
      agent_id: "claude-acp",
      working_dir: "/Users/dev/projects/my-repo",
      branch: "feature/x",
    });
    expect(captured).not.toHaveProperty("worktree");
  });

  it("forwards working_dir and worktree on session.start when set", async () => {
    let captured: Record<string, unknown> | undefined;
    const room = fakeRuntimeRoom(scriptedDaemon((frame) => { captured = frame; }));

    await runHarness(
      agentWithBinding({
        runtime_id: "rt_1",
        acp_agent_id: "claude-acp",
        working_dir: "/Users/dev/projects/my-repo",
        worktree: { branch: "feature/y" },
      }),
      room,
    );

    expect(captured).toMatchObject({
      type: "session.start",
      agent_id: "claude-acp",
      working_dir: "/Users/dev/projects/my-repo",
      worktree: { branch: "feature/y" },
    });
    expect(captured).not.toHaveProperty("branch");
  });

  it("omits working_dir, branch, and worktree entirely when unset", async () => {
    let captured: Record<string, unknown> | undefined;
    const room = fakeRuntimeRoom(scriptedDaemon((frame) => { captured = frame; }));

    await runHarness(
      agentWithBinding({ runtime_id: "rt_1", acp_agent_id: "claude-acp" }),
      room,
    );

    expect(captured).toMatchObject({ type: "session.start", agent_id: "claude-acp" });
    expect(captured).not.toHaveProperty("working_dir");
    expect(captured).not.toHaveProperty("branch");
    expect(captured).not.toHaveProperty("worktree");
  });
});
