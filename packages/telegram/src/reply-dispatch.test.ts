import { describe, expect, it, vi } from "vitest";
import { attachTelegramReply, type TelegramReplyEvent, type TelegramReplySubscribe } from "./reply-dispatch";
import type { TelegramClient } from "./client";

function fakeClient(): TelegramClient {
  return {
    sendMessage: vi.fn().mockResolvedValue({}),
  } as unknown as TelegramClient;
}

/** Fake hub subscribe that captures the onEvent callback + unsubscribe calls. */
function fakeSubscribe(): {
  subscribe: TelegramReplySubscribe;
  emit: (event: TelegramReplyEvent) => void;
  unsubscribe: ReturnType<typeof vi.fn>;
} {
  let onEvent: ((event: TelegramReplyEvent) => void) | null = null;
  const unsubscribe = vi.fn();
  const subscribe: TelegramReplySubscribe = (_sessionId, handler) => {
    onEvent = handler;
    return unsubscribe;
  };
  return {
    subscribe,
    emit: (event) => onEvent?.(event),
    unsubscribe,
  };
}

describe("attachTelegramReply", () => {
  it("sends one message with the accumulated text on session.status_idle", async () => {
    const client = fakeClient();
    const { subscribe, emit, unsubscribe } = fakeSubscribe();

    attachTelegramReply({ sessionId: "sess_1", chatId: 42, client, subscribe });

    emit({ type: "agent.message", content: [{ type: "text", text: "hello" }] });
    emit({ type: "agent.message", content: [{ type: "text", text: "world" }] });
    emit({ type: "session.status_idle" });

    await vi.waitFor(() => expect(client.sendMessage).toHaveBeenCalledTimes(1));
    expect(client.sendMessage).toHaveBeenCalledWith({ chat_id: 42, text: "hello\n\nworld" });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("joins multiple text blocks within a single agent.message without a separator", async () => {
    const client = fakeClient();
    const { subscribe, emit } = fakeSubscribe();

    attachTelegramReply({ sessionId: "sess_1", chatId: 42, client, subscribe });

    emit({
      type: "agent.message",
      content: [
        { type: "text", text: "foo" },
        { type: "text", text: "bar" },
      ],
    });
    emit({ type: "session.status_idle" });

    await vi.waitFor(() => expect(client.sendMessage).toHaveBeenCalledTimes(1));
    expect(client.sendMessage).toHaveBeenCalledWith({ chat_id: 42, text: "foobar" });
  });

  it("sends nothing when no agent.message text arrived before the terminal event", () => {
    const client = fakeClient();
    const { subscribe, emit, unsubscribe } = fakeSubscribe();

    attachTelegramReply({ sessionId: "sess_1", chatId: 42, client, subscribe });

    emit({ type: "session.status_idle" });

    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("is one-shot: a second terminal event does not send again", async () => {
    const client = fakeClient();
    const { subscribe, emit } = fakeSubscribe();

    attachTelegramReply({ sessionId: "sess_1", chatId: 42, client, subscribe });

    emit({ type: "agent.message", content: [{ type: "text", text: "hi" }] });
    emit({ type: "session.status_idle" });
    emit({ type: "session.status_idle" });
    emit({ type: "session.error" });

    await vi.waitFor(() => expect(client.sendMessage).toHaveBeenCalledTimes(1));
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("terminates on session.status_terminated and session.error too", async () => {
    for (const terminalType of ["session.status_terminated", "session.error"] as const) {
      const client = fakeClient();
      const { subscribe, emit, unsubscribe } = fakeSubscribe();

      attachTelegramReply({ sessionId: "sess_1", chatId: 42, client, subscribe });
      emit({ type: "agent.message", content: [{ type: "text", text: "done" }] });
      emit({ type: terminalType });

      await vi.waitFor(() => expect(client.sendMessage).toHaveBeenCalledTimes(1));
      expect(client.sendMessage).toHaveBeenCalledWith({ chat_id: 42, text: "done" });
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    }
  });

  it("logs instead of throwing when sendMessage rejects", async () => {
    const client = {
      sendMessage: vi.fn().mockRejectedValue(new Error("telegram down")),
    } as unknown as TelegramClient;
    const { subscribe, emit } = fakeSubscribe();
    const warn = vi.fn();

    attachTelegramReply({ sessionId: "sess_1", chatId: 42, client, subscribe, log: { warn } });

    emit({ type: "agent.message", content: [{ type: "text", text: "hi" }] });
    emit({ type: "session.status_idle" });

    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
  });

  it("ignores events fired after the terminal event", async () => {
    const client = fakeClient();
    const { subscribe, emit } = fakeSubscribe();

    attachTelegramReply({ sessionId: "sess_1", chatId: 42, client, subscribe });

    emit({ type: "agent.message", content: [{ type: "text", text: "first" }] });
    emit({ type: "session.status_idle" });
    emit({ type: "agent.message", content: [{ type: "text", text: "late" }] });

    await vi.waitFor(() => expect(client.sendMessage).toHaveBeenCalledTimes(1));
    expect(client.sendMessage).toHaveBeenCalledWith({ chat_id: 42, text: "first" });
  });

  it("returns an unsubscribe function that can be called externally", () => {
    const client = fakeClient();
    const { subscribe, unsubscribe } = fakeSubscribe();

    const off = attachTelegramReply({ sessionId: "sess_1", chatId: 42, client, subscribe });
    off();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
