import type { SessionCreator, SessionEventInput } from "@duyet/oma-integrations-core";
import type { TelegramMessage, TelegramClient } from "./client";
import { InMemoryTelegramChatStore, type TelegramChatStore } from "./chat-store";

export interface TelegramAgentConfig {
  sessions: SessionCreator;
  agentId: string;
  vaultIds: string[];
  environmentId?: string;
  /** Defaults to an in-memory store — swap in a durable implementation for
   *  production multi-isolate deployments. See chat-store.ts. */
  store?: TelegramChatStore;
  now?: () => number;
}

export interface TelegramSessionMapping {
  telegramChatId: number;
  omaSessionId: string;
}

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024; // Telegram bot API's own file-size cap

export class TelegramAgentHandler {
  private readonly store: TelegramChatStore;
  private readonly now: () => number;

  constructor(
    private readonly client: TelegramClient,
    private readonly config: TelegramAgentConfig,
  ) {
    this.store = config.store ?? new InMemoryTelegramChatStore();
    this.now = config.now ?? (() => Date.now());
  }

  async handleUpdate(update: { message?: TelegramMessage }): Promise<void> {
    const msg = update.message;
    if (!msg) return;
    if (!msg.text && !msg.photo && !msg.document) return;

    const chatId = msg.chat.id;
    const userId = msg.from?.id.toString() ?? "unknown";
    const event = await this.buildSessionEvent(msg);
    const existing = await this.store.get(chatId);

    if (existing) {
      // Sending any message to a paused session implicitly resumes it
      // platform-side (the sandbox warms lazily on next use) — no explicit
      // /resume call needed here, matching documented session behavior.
      await this.config.sessions.resume(existing.userId, existing.sessionId, event);
      await this.store.touch(chatId, this.now());
      await this.client.sendChatAction(chatId, "typing");
      return;
    }

    const created = await this.config.sessions.create({
      userId,
      agentId: this.config.agentId,
      vaultIds: this.config.vaultIds,
      environmentId: this.config.environmentId ?? "",
      mcpServers: [],
      metadata: { telegram: { chatId, messageId: msg.message_id, userId: msg.from?.id } },
      initialEvent: event,
    });

    await this.store.set({
      chatId,
      sessionId: created.sessionId,
      userId,
      lastActivityAtMs: this.now(),
    });
    await this.client.sendChatAction(chatId, "typing");
  }

  private async buildSessionEvent(msg: TelegramMessage): Promise<SessionEventInput> {
    const content: Array<SessionEventInput["content"][number]> = [];
    const text = msg.text ?? msg.caption ?? "";
    if (text) content.push({ type: "text", text });

    if (msg.photo && msg.photo.length > 0) {
      // Telegram returns ascending resolutions; the largest (best quality)
      // is last, capped by the bot API's own file-size limits.
      const largest = msg.photo[msg.photo.length - 1];
      const block = await this.downloadAsBlock(largest.file_id, "image", largest.file_size);
      if (block) content.push(block);
    }

    if (msg.document) {
      const block = await this.downloadAsBlock(
        msg.document.file_id,
        "document",
        msg.document.file_size,
        msg.document.file_name,
        msg.document.mime_type,
      );
      if (block) content.push(block);
    }

    // Fall back to a text placeholder if an attachment couldn't be embedded
    // (oversized / expired file) so the agent still sees *something*.
    if (content.length === 0) content.push({ type: "text", text: "" });

    return {
      type: "user.message",
      content,
      metadata: {
        telegram: {
          chatId: msg.chat.id,
          messageId: msg.message_id,
          userId: msg.from?.id,
          username: msg.from?.username ?? null,
        },
      },
    };
  }

  private async downloadAsBlock(
    fileId: string,
    kind: "image" | "document",
    fileSize: number | undefined,
    fileName?: string,
    mimeType?: string,
  ): Promise<SessionEventInput["content"][number] | null> {
    if (fileSize && fileSize > MAX_ATTACHMENT_BYTES) return null;

    const downloaded = await this.client.downloadFileAsBase64(fileId);
    if (!downloaded) return null;

    const mediaType = mimeType ?? guessMediaType(downloaded.filePath, kind);

    if (kind === "image") {
      return {
        type: "image",
        source: { type: "base64", media_type: mediaType, data: downloaded.data },
      };
    }
    return {
      type: "document",
      source: { type: "base64", media_type: mediaType, data: downloaded.data },
      title: fileName ?? downloaded.filePath.split("/").pop(),
    };
  }

  async getSessionForChat(chatId: number): Promise<string | undefined> {
    return (await this.store.get(chatId))?.sessionId;
  }
}

function guessMediaType(filePath: string, kind: "image" | "document"): string {
  const ext = filePath.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    pdf: "application/pdf",
    txt: "text/plain",
    csv: "text/csv",
    json: "application/json",
  };
  if (ext && map[ext]) return map[ext];
  return kind === "image" ? "image/jpeg" : "application/octet-stream";
}
