import type { SessionCreator, SessionEventInput } from "@duyet/oma-integrations-core";
import type { TelegramMessage, TelegramClient } from "./client";

export interface TelegramAgentConfig {
  sessions: SessionCreator;
  agentId: string;
  vaultIds: string[];
  environmentId?: string;
}

export interface TelegramSessionMapping {
  telegramChatId: number;
  omaSessionId: string;
}

export class TelegramAgentHandler {
  private readonly sessionMap = new Map<number, string>();

  constructor(
    private readonly client: TelegramClient,
    private readonly config: TelegramAgentConfig,
  ) {}

  async handleUpdate(update: { message?: TelegramMessage }): Promise<void> {
    const msg = update.message;
    if (!msg?.text) return;

    const chatId = msg.chat.id;
    const sessionId = this.sessionMap.get(chatId);

    if (sessionId) {
      await this.config.sessions.resume(
        msg.from?.id.toString() ?? "unknown",
        sessionId,
        this.buildSessionEvent(msg),
      );
      return;
    }

    const created = await this.config.sessions.create({
      userId: msg.from?.id.toString() ?? "unknown",
      agentId: this.config.agentId,
      vaultIds: this.config.vaultIds,
      environmentId: this.config.environmentId ?? "",
      mcpServers: [],
      metadata: { telegram: { chatId, messageId: msg.message_id, userId: msg.from?.id } },
      initialEvent: this.buildSessionEvent(msg),
    });

    this.sessionMap.set(chatId, created.sessionId);
    await this.client.sendChatAction(chatId, "typing");
  }

  private buildSessionEvent(msg: TelegramMessage): SessionEventInput {
    return {
      type: "user.message",
      content: [{ type: "text", text: msg.text ?? "" }],
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

  getSessionForChat(chatId: number): string | undefined {
    return this.sessionMap.get(chatId);
  }
}
