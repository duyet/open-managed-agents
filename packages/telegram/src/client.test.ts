import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramClient, TelegramApiError } from "./client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("TelegramClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sendMessage posts to the bot API and returns the result", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ ok: true, result: { message_id: 5, chat: { id: 1, type: "private" }, date: 0 } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new TelegramClient("TOKEN");
    const msg = await client.sendMessage({ chat_id: 1, text: "hi" });

    expect(msg.message_id).toBe(5);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/botTOKEN/sendMessage",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("throws TelegramApiError when Telegram reports ok: false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ ok: false, description: "bad request", error_code: 400 }, 400)),
    );

    const client = new TelegramClient("TOKEN");
    await expect(client.sendMessage({ chat_id: 1, text: "hi" })).rejects.toThrow(TelegramApiError);
  });

  it("downloadFileAsBase64 resolves getFile then downloads + base64-encodes the bytes", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/getFile")) {
        return Promise.resolve(jsonResponse({ ok: true, result: { file_id: "f1", file_path: "photos/f1.jpg" } }));
      }
      // Raw file download.
      return Promise.resolve(new Response(new Uint8Array([1, 2, 3]).buffer, { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new TelegramClient("TOKEN");
    const result = await client.downloadFileAsBase64("f1");

    expect(result).not.toBeNull();
    expect(result?.filePath).toBe("photos/f1.jpg");
    expect(Buffer.from(result?.data ?? "", "base64")).toEqual(Buffer.from([1, 2, 3]));
    expect(fetchMock).toHaveBeenCalledWith("https://api.telegram.org/file/botTOKEN/photos/f1.jpg");
  });

  it("downloadFileAsBase64 returns null when Telegram has no file_path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ ok: true, result: { file_id: "f1" } })),
    );

    const client = new TelegramClient("TOKEN");
    expect(await client.downloadFileAsBase64("f1")).toBeNull();
  });
});
