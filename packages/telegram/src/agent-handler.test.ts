import { describe, expect, it, vi, beforeEach } from "vitest";
import { TelegramAgentHandler } from "./agent-handler";
import { InMemoryTelegramChatStore } from "./chat-store";
import type { TelegramClient, TelegramMessage } from "./client";
import { FakeSessionCreator } from "@duyet/oma-integrations-core/test-fakes";

function fakeClient(overrides: Partial<TelegramClient> = {}): TelegramClient {
  return {
    sendMessage: vi.fn(),
    sendChatAction: vi.fn().mockResolvedValue(true),
    setWebhook: vi.fn(),
    getFile: vi.fn(),
    getFileUrl: vi.fn(),
    downloadFileAsBase64: vi.fn(),
    ...overrides,
  } as unknown as TelegramClient;
}

function textMessage(overrides: Partial<TelegramMessage> = {}): TelegramMessage {
  return {
    message_id: 1,
    chat: { id: 42, type: "private" },
    from: { id: 7, is_bot: false, first_name: "Duyet", username: "duyet" },
    date: 1000,
    text: "hello",
    ...overrides,
  };
}

describe("TelegramAgentHandler", () => {
  let sessions: FakeSessionCreator;
  let store: InMemoryTelegramChatStore;

  beforeEach(() => {
    sessions = new FakeSessionCreator();
    store = new InMemoryTelegramChatStore();
  });

  it("creates a new session on first message from a chat", async () => {
    const client = fakeClient();
    const handler = new TelegramAgentHandler(client, {
      sessions,
      agentId: "agent_1",
      vaultIds: ["vlt_1"],
      environmentId: "env_1",
      store,
      now: () => 1_000,
    });

    await handler.handleUpdate({ message: textMessage() });

    expect(sessions.created).toHaveLength(1);
    expect(sessions.created[0]).toMatchObject({
      userId: "7",
      agentId: "agent_1",
      vaultIds: ["vlt_1"],
      environmentId: "env_1",
    });
    expect(sessions.created[0].initialEvent.content).toEqual([{ type: "text", text: "hello" }]);
    expect(await handler.getSessionForChat(42)).toBe("sess_1");
    expect(client.sendChatAction).toHaveBeenCalledWith(42, "typing");
  });

  it("resumes the existing session on a second message from the same chat", async () => {
    const client = fakeClient();
    const handler = new TelegramAgentHandler(client, {
      sessions,
      agentId: "agent_1",
      vaultIds: [],
      store,
      now: () => 1_000,
    });

    await handler.handleUpdate({ message: textMessage({ message_id: 1, text: "first" }) });
    await handler.handleUpdate({ message: textMessage({ message_id: 2, text: "second" }) });

    expect(sessions.created).toHaveLength(1);
    expect(sessions.resumed).toHaveLength(1);
    expect(sessions.resumed[0]).toMatchObject({ userId: "7", sessionId: "sess_1" });
    expect(sessions.resumed[0].event.content).toEqual([{ type: "text", text: "second" }]);
  });

  it("bumps last-activity and un-pauses on a message to a paused chat", async () => {
    const client = fakeClient();
    const handler = new TelegramAgentHandler(client, {
      sessions,
      agentId: "agent_1",
      vaultIds: [],
      store,
      now: () => 1_000,
    });
    await handler.handleUpdate({ message: textMessage() });
    await store.markPaused(42, 2_000);
    expect(await store.listIdle(2_000, 0)).toHaveLength(0); // paused chats are excluded from idle sweeps

    await handler.handleUpdate({ message: textMessage({ message_id: 3, text: "back" }) });
    const state = await store.get(42);
    expect(state?.paused).toBe(false);
  });

  it("forwards a photo as an image content block", async () => {
    const client = fakeClient({
      downloadFileAsBase64: vi.fn().mockResolvedValue({ data: "YmFzZTY0", filePath: "photos/file_1.jpg" }),
    });
    const handler = new TelegramAgentHandler(client, {
      sessions,
      agentId: "agent_1",
      vaultIds: [],
      store,
      now: () => 1_000,
    });

    await handler.handleUpdate({
      message: textMessage({
        text: undefined,
        caption: "check this out",
        photo: [
          { file_id: "small", file_unique_id: "u1", width: 90, height: 90 },
          { file_id: "large", file_unique_id: "u2", width: 800, height: 600, file_size: 1024 },
        ],
      }),
    });

    expect(client.downloadFileAsBase64).toHaveBeenCalledWith("large");
    const content = sessions.created[0].initialEvent.content;
    expect(content).toEqual([
      { type: "text", text: "check this out" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "YmFzZTY0" } },
    ]);
  });

  it("forwards a document as a document content block with title", async () => {
    const client = fakeClient({
      downloadFileAsBase64: vi.fn().mockResolvedValue({ data: "cGRmZGF0YQ==", filePath: "documents/f1.pdf" }),
    });
    const handler = new TelegramAgentHandler(client, {
      sessions,
      agentId: "agent_1",
      vaultIds: [],
      store,
      now: () => 1_000,
    });

    await handler.handleUpdate({
      message: textMessage({
        text: undefined,
        document: { file_id: "doc1", file_unique_id: "u3", file_name: "report.pdf", mime_type: "application/pdf" },
      }),
    });

    const content = sessions.created[0].initialEvent.content;
    expect(content).toEqual([
      {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: "cGRmZGF0YQ==" },
        title: "report.pdf",
      },
    ]);
  });

  it("skips attachments over the size cap without downloading", async () => {
    const client = fakeClient();
    const handler = new TelegramAgentHandler(client, {
      sessions,
      agentId: "agent_1",
      vaultIds: [],
      store,
      now: () => 1_000,
    });

    await handler.handleUpdate({
      message: textMessage({
        text: undefined,
        document: {
          file_id: "huge",
          file_unique_id: "u4",
          file_size: 25 * 1024 * 1024,
        },
      }),
    });

    expect(client.downloadFileAsBase64).not.toHaveBeenCalled();
    expect(sessions.created[0].initialEvent.content).toEqual([{ type: "text", text: "" }]);
  });

  it("ignores updates with no message and no text/photo/document", async () => {
    const client = fakeClient();
    const handler = new TelegramAgentHandler(client, {
      sessions,
      agentId: "agent_1",
      vaultIds: [],
      store,
    });

    await handler.handleUpdate({});
    await handler.handleUpdate({ message: { ...textMessage(), text: undefined } });

    expect(sessions.created).toHaveLength(0);
  });
});
