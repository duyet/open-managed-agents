/**
 * Covers AcpSessionImpl's best-effort model / reasoning-effort override
 * application (issue #269: ACP proxy harness had no per-agent
 * model/reasoning-effort override). SessionManager (packages/cli's bridge
 * daemon) forwards `AgentConfig.runtime_binding.model` /
 * `.reasoning_effort` into `SessionOptions.modelOverride` /
 * `.reasoningEffortOverride`; `#applyOverrides` (session.ts) is where they
 * actually get attempted against the spawned ACP child once its session is
 * live, via ACP's experimental `session/set_model` and
 * `session/set_config_option` methods.
 *
 * Rather than hand-rolling JSON-RPC frames, each test wires a real
 * @agentclientprotocol/sdk `AgentSideConnection` (playing the ACP child)
 * to the `AcpSessionImpl` under test (playing the client/host) over an
 * in-memory ndjson duplex — so the protocol handshake, request routing,
 * and validation are the SDK's real code, not a mock of it. Only the
 * *content* of the fake agent's responses (what it advertises as
 * selectable) is test-controlled.
 */
import { AgentSideConnection, ndJsonStream, type Agent } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { AcpSessionImpl } from "./session.js";
import type { ChildHandle, SessionOptions } from "./types.js";

/** Minimal Agent stub for methods AcpSessionImpl.init() never exercises. */
const AGENT_DEFAULTS: Pick<Agent, "authenticate" | "prompt" | "cancel"> = {
  authenticate: async () => ({}) as never,
  prompt: async () => {
    throw new Error("prompt() not exercised by these tests");
  },
  cancel: async () => {},
};

/**
 * Connects a fake in-process ACP agent (server role, via AgentSideConnection)
 * to an in-memory ndjson duplex, and returns the `ChildHandle` half that an
 * AcpSessionImpl (client role) can be constructed against.
 */
function connectFakeAgent(
  agentImpl: Partial<Agent> & Pick<Agent, "initialize" | "newSession">,
): ChildHandle {
  const clientToAgent = new TransformStream<Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array>();

  const agentStream = ndJsonStream(agentToClient.writable, clientToAgent.readable);
  new AgentSideConnection(() => ({ ...AGENT_DEFAULTS, ...agentImpl }) as Agent, agentStream);

  let resolveExit!: (v: { code: number | null; signal: string | null }) => void;
  const exited = new Promise<{ code: number | null; signal: string | null }>((r) => {
    resolveExit = r;
  });

  return {
    stdin: clientToAgent.writable,
    stdout: agentToClient.readable,
    stderr: new ReadableStream(),
    kill: async () => {
      resolveExit({ code: 0, signal: null });
    },
    exited,
  };
}

function baseOptions(overrides: Partial<SessionOptions> = {}): SessionOptions {
  return { agent: { command: "fake-acp" }, ...overrides };
}

describe("AcpSessionImpl model/reasoning-effort overrides (#269)", () => {
  it("applies modelOverride via session/set_model when the agent advertises it as selectable", async () => {
    let captured: unknown;
    const child = connectFakeAgent({
      initialize: async () => ({ protocolVersion: 1, agentCapabilities: {} }) as never,
      newSession: async () =>
        ({
          sessionId: "acp-sess-1",
          models: {
            currentModelId: "claude-haiku-4-5",
            availableModels: [
              { modelId: "claude-haiku-4-5", name: "Haiku" },
              { modelId: "claude-sonnet-4-6", name: "Sonnet" },
            ],
          },
        }) as never,
      unstable_setSessionModel: async (params) => {
        captured = params;
        return {};
      },
    });

    const session = new AcpSessionImpl({
      child,
      id: "test-1",
      options: baseOptions({ modelOverride: "claude-sonnet-4-6" }),
    });
    await session.init();

    expect(captured).toMatchObject({ sessionId: "acp-sess-1", modelId: "claude-sonnet-4-6" });
    expect(session.modelOverrideOutcome).toEqual({ requested: "claude-sonnet-4-6", applied: true });
  });

  it("skips modelOverride without calling session/set_model when the agent doesn't advertise it", async () => {
    let called = false;
    const child = connectFakeAgent({
      initialize: async () => ({ protocolVersion: 1, agentCapabilities: {} }) as never,
      // No `models` at all — plain claude-acp-shaped response.
      newSession: async () => ({ sessionId: "acp-sess-2" }) as never,
      unstable_setSessionModel: async () => {
        called = true;
        return {};
      },
    });

    const session = new AcpSessionImpl({
      child,
      id: "test-2",
      options: baseOptions({ modelOverride: "claude-sonnet-4-6" }),
    });
    await session.init();

    expect(called).toBe(false);
    expect(session.modelOverrideOutcome?.applied).toBe(false);
    expect(session.modelOverrideOutcome?.reason).toMatch(/does not advertise/);
  });

  it("applies reasoningEffortOverride via session/set_config_option matched by thought_level category", async () => {
    let captured: unknown;
    const child = connectFakeAgent({
      initialize: async () => ({ protocolVersion: 1, agentCapabilities: {} }) as never,
      newSession: async () =>
        ({
          sessionId: "acp-sess-3",
          configOptions: [
            {
              type: "select",
              id: "reasoning",
              name: "Reasoning effort",
              category: "thought_level",
              currentValue: "medium",
              options: [
                { name: "Minimal", value: "minimal" },
                { name: "Low", value: "low" },
                { name: "Medium", value: "medium" },
                { name: "High", value: "high" },
              ],
            },
          ],
        }) as never,
      setSessionConfigOption: async (params) => {
        captured = params;
        return { configOptions: [] };
      },
    });

    const session = new AcpSessionImpl({
      child,
      id: "test-3",
      // Requested value is upper-cased — matching against the agent's
      // "high" value id must be case-insensitive.
      options: baseOptions({ reasoningEffortOverride: "HIGH" }),
    });
    await session.init();

    expect(captured).toMatchObject({ sessionId: "acp-sess-3", configId: "reasoning", value: "high" });
    expect(session.reasoningEffortOverrideOutcome).toEqual({ requested: "HIGH", applied: true });
  });

  it("skips reasoningEffortOverride when no thought_level config option is advertised", async () => {
    const child = connectFakeAgent({
      initialize: async () => ({ protocolVersion: 1, agentCapabilities: {} }) as never,
      newSession: async () => ({ sessionId: "acp-sess-4" }) as never,
    });

    const session = new AcpSessionImpl({
      child,
      id: "test-4",
      options: baseOptions({ reasoningEffortOverride: "high" }),
    });
    await session.init();

    expect(session.reasoningEffortOverrideOutcome?.applied).toBe(false);
    expect(session.reasoningEffortOverrideOutcome?.reason).toMatch(/thought_level/);
  });

  it("is a no-op — no outcome recorded — when neither override is requested", async () => {
    const child = connectFakeAgent({
      initialize: async () => ({ protocolVersion: 1, agentCapabilities: {} }) as never,
      newSession: async () => ({ sessionId: "acp-sess-5" }) as never,
    });

    const session = new AcpSessionImpl({ child, id: "test-5", options: baseOptions() });
    await session.init();

    expect(session.modelOverrideOutcome).toBeUndefined();
    expect(session.reasoningEffortOverrideOutcome).toBeUndefined();
  });
});
