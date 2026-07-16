// NodeTelegramSessionCreator — the piece that makes Telegram work end to
// end on self-host Node: create() must both kick a harness turn (via
// sessionRouter.appendEvent) AND attach a one-shot hub observer so the
// agent's final reply gets posted back to the originating Telegram chat
// (design doc "Approach B" — direct hub observer, no generic agent.notify
// fan-out with a dynamic per-session target on Node).
//
// Uses in-memory SessionService/AgentService fakes (real classes backed by
// in-memory repos) plus the real InProcessEventStreamHub, so this exercises
// the actual attach/publish wiring without a SQL bootstrap.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createInMemorySessionService } from "@duyet/oma-sessions-store/test-fakes";
import { createInMemoryAgentService } from "@duyet/oma-agents-store/test-fakes";
import { InProcessEventStreamHub } from "../src/lib/event-stream-hub.js";
import { NodeTelegramSessionCreator, type AppendEventRouter } from "../src/lib/node-telegram.js";
import type { TelegramClient } from "@duyet/oma-telegram";

const TENANT = "tn_telegram";
const USER = "usr_telegram";

async function bootstrap() {
  const { service: sessionsService } = createInMemorySessionService();
  const { service: agentsService } = createInMemoryAgentService();
  const agent = await agentsService.create({
    tenantId: TENANT,
    input: { name: "Telegram Bot", model: "claude-sonnet-4-6", system: "You are helpful." },
  });

  const hub = new InProcessEventStreamHub();
  const sendMessage = vi.fn().mockResolvedValue({});
  const client = { sendMessage } as unknown as TelegramClient;

  // Fake router that mimics NodeSessionRouter.appendEvent: persist (no-op
  // here) + publish onto the hub, which is exactly what drives the harness
  // turn + the reply observer in production.
  const appendedEvents: Array<{ sessionId: string; event: unknown }> = [];
  const sessionRouter: AppendEventRouter = {
    appendEvent: vi.fn(async (sessionId: string, event: unknown) => {
      appendedEvents.push({ sessionId, event });
      hub.publish(sessionId, event as never);
      return { status: 202, body: "{}" };
    }),
  };

  const creator = new NodeTelegramSessionCreator({
    sessionsService,
    agentsService,
    sessionRouter,
    hub,
    client,
    resolveTenantId: async (userId) => (userId === USER ? TENANT : null),
  });

  return { creator, sessionsService, hub, client, sendMessage, appendedEvents, agentId: agent.id };
}

describe("NodeTelegramSessionCreator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("create() kicks a turn via sessionRouter.appendEvent with the initial message", async () => {
    const { creator, appendedEvents, agentId } = await bootstrap();

    const { sessionId } = await creator.create({
      userId: USER,
      agentId,
      environmentId: "env_local",
      vaultIds: [],
      mcpServers: [],
      metadata: { telegram: { chatId: 42, messageId: 1 } },
      initialEvent: { type: "user.message", content: [{ type: "text", text: "hello bot" }] },
    });

    expect(sessionId).toBeTruthy();
    expect(appendedEvents).toHaveLength(1);
    expect(appendedEvents[0]).toMatchObject({
      sessionId,
      event: { type: "user.message", content: [{ type: "text", text: "hello bot" }] },
    });
  });

  it("create() attaches a hub observer that posts the agent's reply once the turn goes idle", async () => {
    const { creator, hub, sendMessage, agentId } = await bootstrap();

    const { sessionId } = await creator.create({
      userId: USER,
      agentId,
      environmentId: "env_local",
      vaultIds: [],
      mcpServers: [],
      metadata: { telegram: { chatId: 42, messageId: 1 } },
      initialEvent: { type: "user.message", content: [{ type: "text", text: "hello bot" }] },
    });

    // Simulate the harness turn: agent.message events, then terminal idle —
    // exactly what NodeHarnessRuntime.broadcast publishes in production.
    hub.publish(sessionId, { type: "agent.message", content: [{ type: "text", text: "hi" }] } as never);
    hub.publish(sessionId, { type: "session.status_idle" } as never);

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage).toHaveBeenCalledWith({ chat_id: 42, text: "hi" });
  });

  it("resume() appends the event and re-attaches the reply observer for the next turn", async () => {
    const { creator, hub, sendMessage, appendedEvents, agentId } = await bootstrap();

    const { sessionId } = await creator.create({
      userId: USER,
      agentId,
      environmentId: "env_local",
      vaultIds: [],
      mcpServers: [],
      metadata: { telegram: { chatId: 42, messageId: 1 } },
      initialEvent: { type: "user.message", content: [{ type: "text", text: "first" }] },
    });
    // First turn completes with no reply text.
    hub.publish(sessionId, { type: "session.status_idle" } as never);

    await creator.resume(USER, sessionId, {
      type: "user.message",
      content: [{ type: "text", text: "second" }],
    });

    expect(appendedEvents).toHaveLength(2);
    expect(appendedEvents[1]).toMatchObject({
      sessionId,
      event: { type: "user.message", content: [{ type: "text", text: "second" }] },
    });

    hub.publish(sessionId, { type: "agent.message", content: [{ type: "text", text: "second reply" }] } as never);
    hub.publish(sessionId, { type: "session.status_idle" } as never);

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage).toHaveBeenCalledWith({ chat_id: 42, text: "second reply" });
  });

  it("create() rejects when the user has no resolvable tenant", async () => {
    const { creator, agentId } = await bootstrap();

    await expect(
      creator.create({
        userId: "usr_unknown",
        agentId,
        environmentId: "env_local",
        vaultIds: [],
        mcpServers: [],
        metadata: { telegram: { chatId: 1 } },
        initialEvent: { type: "user.message", content: [{ type: "text", text: "hi" }] },
      }),
    ).rejects.toThrow();
  });
});
