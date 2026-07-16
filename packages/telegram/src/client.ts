const TELEGRAM_API_BASE = "https://api.telegram.org";

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  reply_to_message?: TelegramMessage;
  entities?: Array<{
    type: string;
    offset: number;
    length: number;
  }>;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: {
    id: string;
    from: TelegramUser;
    message?: TelegramMessage;
    data?: string;
  };
}

export interface SendMessageParams {
  chat_id: number | string;
  text: string;
  parse_mode?: "MarkdownV2" | "HTML";
  disable_web_page_preview?: boolean;
  disable_notification?: boolean;
  reply_to_message_id?: number;
  allow_sending_without_reply?: boolean;
}

export interface SetWebhookParams {
  url: string;
  secret_token?: string;
  allowed_updates?: string[];
  drop_pending_updates?: boolean;
  max_connections?: number;
}

export class TelegramApiError extends Error {
  constructor(
    public readonly method: string,
    public readonly telegramError: string,
    public readonly status: number,
    public readonly errorCode?: number,
  ) {
    super(`Telegram ${method} failed: ${telegramError} (HTTP ${status})`);
  }
}

export class TelegramClient {
  private readonly apiUrl: string;

  constructor(
    private readonly botToken: string,
    private readonly baseUrl: string = TELEGRAM_API_BASE,
  ) {
    this.apiUrl = `${baseUrl}/bot${botToken}`;
  }

  private async request<T>(method: string, body?: Record<string, unknown>): Promise<T> {
    const url = `${this.apiUrl}/${method}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });

    const parsed = (await res.json()) as { ok: boolean; [k: string]: unknown };

    if (parsed.ok !== true) {
      const err = typeof parsed.description === "string" ? parsed.description : "unknown_error";
      throw new TelegramApiError(
        method,
        err,
        res.status,
        typeof parsed.error_code === "number" ? parsed.error_code : undefined,
      );
    }

    return parsed.result as T;
  }

  async sendMessage(params: SendMessageParams): Promise<TelegramMessage> {
    return this.request<TelegramMessage>("sendMessage", params as unknown as Record<string, unknown>);
  }

  async sendChatAction(chatId: number | string, action: string): Promise<boolean> {
    return this.request<boolean>("sendChatAction", { chat_id: chatId, action });
  }

  async setWebhook(params: SetWebhookParams): Promise<boolean> {
    return this.request<boolean>("setWebhook", params as unknown as Record<string, unknown>);
  }

  async getFile(fileId: string): Promise<{ file_id: string; file_path?: string }> {
    return this.request<{ file_id: string; file_path?: string }>("getFile", { file_id: fileId });
  }

  async getFileUrl(fileId: string): Promise<string | null> {
    const file = await this.getFile(fileId);
    if (!file.file_path) return null;
    return `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
  }
}
