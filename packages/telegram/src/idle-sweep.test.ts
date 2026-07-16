import { describe, expect, it, vi } from "vitest";
import { sweepIdleTelegramChats, DEFAULT_IDLE_TIMEOUT_MS } from "./idle-sweep";
import { InMemoryTelegramChatStore } from "./chat-store";

describe("sweepIdleTelegramChats", () => {
  it("pauses chats idle for >= the threshold and marks them paused", async () => {
    const store = new InMemoryTelegramChatStore();
    await store.set({ chatId: 1, sessionId: "sess_1", userId: "u1", lastActivityAtMs: 0 });
    await store.set({ chatId: 2, sessionId: "sess_2", userId: "u2", lastActivityAtMs: 4 * 60 * 1000 });

    const pause = vi.fn().mockResolvedValue(undefined);
    const result = await sweepIdleTelegramChats({
      store,
      pause,
      now: () => 5 * 60 * 1000,
      idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
    });

    expect(pause).toHaveBeenCalledExactlyOnceWith("u1", "sess_1");
    expect(result.paused).toEqual([1]);
    expect((await store.get(1))?.paused).toBe(true);
    expect((await store.get(2))?.paused).toBe(false);
  });

  it("does not re-sweep chats already paused", async () => {
    const store = new InMemoryTelegramChatStore();
    await store.set({ chatId: 1, sessionId: "sess_1", userId: "u1", lastActivityAtMs: 0 });
    await store.markPaused(1, 1_000);

    const pause = vi.fn();
    const result = await sweepIdleTelegramChats({ store, pause, now: () => 10 * 60 * 1000 });

    expect(pause).not.toHaveBeenCalled();
    expect(result.checked).toBe(0);
  });

  it("records a failure without throwing when pause rejects, and leaves the chat eligible for retry", async () => {
    const store = new InMemoryTelegramChatStore();
    await store.set({ chatId: 1, sessionId: "sess_1", userId: "u1", lastActivityAtMs: 0 });

    const pause = vi.fn().mockRejectedValue(new Error("409 session mid-turn"));
    const result = await sweepIdleTelegramChats({ store, pause, now: () => DEFAULT_IDLE_TIMEOUT_MS });

    expect(result.paused).toEqual([]);
    expect(result.failed).toEqual([{ chatId: 1, error: "409 session mid-turn" }]);
    expect((await store.get(1))?.paused).toBe(false);
  });

  it("uses the default 5-minute threshold when idleTimeoutMs is omitted", async () => {
    const store = new InMemoryTelegramChatStore();
    await store.set({ chatId: 1, sessionId: "sess_1", userId: "u1", lastActivityAtMs: 0 });

    const pause = vi.fn().mockResolvedValue(undefined);
    const justUnder = await sweepIdleTelegramChats({ store, pause, now: () => DEFAULT_IDLE_TIMEOUT_MS - 1 });
    expect(justUnder.paused).toEqual([]);

    const atThreshold = await sweepIdleTelegramChats({ store, pause, now: () => DEFAULT_IDLE_TIMEOUT_MS });
    expect(atThreshold.paused).toEqual([1]);
  });
});
