// Chat ↔ session mapping + last-activity tracking for Telegram.
//
// Kept as a tiny runtime-agnostic port (mirrors the SessionCreator/HttpClient
// pattern in @duyet/oma-integrations-core) so the host app can back it with
// whatever storage fits its deployment — the default export here is a plain
// in-memory Map, adequate for a single long-lived Worker isolate / Node
// process but NOT durable across restarts or multi-isolate fan-out. Swap in
// a KV/D1-backed implementation for production multi-instance deployments.

export interface TelegramChatState {
  readonly chatId: number;
  readonly sessionId: string;
  /** OMA userId that owns the session — required to call SessionCreator.pause/resume. */
  readonly userId: string;
  readonly lastActivityAtMs: number;
  readonly paused: boolean;
}

export interface TelegramChatStore {
  get(chatId: number): Promise<TelegramChatState | undefined>;
  /** Create or replace the mapping for a chat, marking it active (unpaused). */
  set(state: Omit<TelegramChatState, "paused">): Promise<void>;
  /** Bump `lastActivityAtMs` and clear `paused` (a new message always un-pauses). */
  touch(chatId: number, nowMs: number): Promise<void>;
  markPaused(chatId: number, nowMs: number): Promise<void>;
  /** All chats whose session is active (not yet paused) and idle for >= thresholdMs. */
  listIdle(nowMs: number, thresholdMs: number): Promise<readonly TelegramChatState[]>;
}

export class InMemoryTelegramChatStore implements TelegramChatStore {
  private readonly rows = new Map<number, TelegramChatState>();

  async get(chatId: number): Promise<TelegramChatState | undefined> {
    return this.rows.get(chatId);
  }

  async set(state: Omit<TelegramChatState, "paused">): Promise<void> {
    this.rows.set(state.chatId, { ...state, paused: false });
  }

  async touch(chatId: number, nowMs: number): Promise<void> {
    const row = this.rows.get(chatId);
    if (!row) return;
    this.rows.set(chatId, { ...row, lastActivityAtMs: nowMs, paused: false });
  }

  async markPaused(chatId: number, nowMs: number): Promise<void> {
    const row = this.rows.get(chatId);
    if (!row) return;
    this.rows.set(chatId, { ...row, lastActivityAtMs: nowMs, paused: true });
  }

  async listIdle(nowMs: number, thresholdMs: number): Promise<readonly TelegramChatState[]> {
    return [...this.rows.values()].filter(
      (row) => !row.paused && nowMs - row.lastActivityAtMs >= thresholdMs,
    );
  }
}
