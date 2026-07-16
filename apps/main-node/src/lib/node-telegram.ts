// Node SessionCreator for Telegram — routes inbound webhook turns through
// the same NodeSessionRouter every other event source (public API, SDK,
// CLI) uses, and wires a one-shot direct-hub-observer (design doc
// "Approach B" — see the shared telegram-node-design notes) so the agent's
// final reply gets posted back to the originating Telegram chat.
//
// Node has no generic `agent.notify` fan-out with a per-session *dynamic*
// target (the chat_id changes per inbound message; `agent.notify` is static
// agent config), so this bypasses that mechanism entirely: chat_id travels
// through `session.metadata.telegram.chatId` (stamped by TelegramAgentHandler
// at create time) and the reply is posted directly once the harness turn
// reaches a terminal event on the EventStreamHub.
//
// NOTE: `InProcessSessionCreator` in node-install-bridge.ts already exists,
// but its `.create()` intentionally drops `input.initialEvent` and never
// kicks a harness turn — every other provider (Linear/GitHub/Slack) calls
// `create()` then separately `resume()`s to start the turn once webhook
// processing completes. `TelegramAgentHandler.handleUpdate` passes
// `initialEvent` straight into `create()` and expects the turn to start
// immediately, so this is a distinct SessionCreator rather than a reuse.

import type {
  CreateSessionInput,
  SessionCreator,
  SessionEventInput,
  SessionId,
  UserId,
} from "@duyet/oma-integrations-core";
import type { AgentService } from "@duyet/oma-agents-store";
import type { SessionService } from "@duyet/oma-sessions-store";
import type { SessionEvent, UserMessageEvent } from "@duyet/oma-shared";
import {
  attachTelegramReply,
  type TelegramClient,
  type TelegramReplyEvent,
  type TelegramReplySubscribe,
} from "@duyet/oma-telegram";
import { getLogger } from "@duyet/oma-observability";
import type { EventStreamHub } from "./event-stream-hub";

const log = getLogger("apps.main-node.node-telegram");

/** The one NodeSessionRouter method this creator needs — narrowed so unit
 *  tests can pass a plain fake instead of standing up a full router. */
export interface AppendEventRouter {
  appendEvent(sessionId: string, event: SessionEvent): Promise<unknown>;
}

export interface NodeTelegramSessionCreatorOpts {
  sessionsService: SessionService;
  agentsService: AgentService;
  sessionRouter: AppendEventRouter;
  hub: EventStreamHub;
  client: TelegramClient;
  /** Look up the OMA tenantId for a userId. Mirrors NodeInstallBridge's
   *  resolveTenantId callback so this stays agnostic to better-auth wiring. */
  resolveTenantId: (userId: string) => Promise<string | null>;
}

function telegramChatId(metadata: Record<string, unknown> | null | undefined): number {
  const chatId = (metadata as { telegram?: { chatId?: number } } | null | undefined)?.telegram?.chatId;
  if (typeof chatId !== "number") {
    throw new Error("session metadata missing telegram.chatId");
  }
  return chatId;
}

function toUserMessage(event: SessionEventInput): UserMessageEvent {
  return {
    type: "user.message",
    content: event.content,
    ...(event.metadata ? { metadata: event.metadata } : {}),
  } as unknown as UserMessageEvent;
}

export class NodeTelegramSessionCreator implements SessionCreator {
  constructor(private readonly opts: NodeTelegramSessionCreatorOpts) {}

  /** EventStreamHub.attach adapted to the TelegramReplySubscribe shape. */
  private readonly hubSubscribe: TelegramReplySubscribe = (sessionId, onEvent) => {
    const writer = {
      closed: false,
      write: (event: unknown) => onEvent(event as TelegramReplyEvent),
      close: () => {},
    };
    return this.opts.hub.attach(sessionId, writer);
  };

  async create(input: CreateSessionInput): Promise<{ sessionId: SessionId }> {
    const tenantId = await this.opts.resolveTenantId(input.userId);
    if (!tenantId) throw new Error("user has no tenant");
    const agentRow = await this.opts.agentsService.get({ tenantId, agentId: input.agentId });
    if (!agentRow) throw new Error("agent not found in tenant");
    // Strip tenant_id like InProcessSessionCreator.create does so the
    // snapshot shape matches.
    const agentBase = { ...agentRow, tenant_id: undefined } as unknown as Record<string, unknown>;
    delete agentBase.tenant_id;

    // Self-host agents always run on local-runtime — synthetic env snapshot,
    // mirrors InProcessSessionCreator.create verbatim so install-triggered
    // and webhook-triggered sessions don't diverge.
    const envSnapshot = { id: input.environmentId, runtime: "local", sandbox_template: null };
    const meta = Object.keys(input.metadata ?? {}).length === 0 ? undefined : input.metadata;

    const { session } = await this.opts.sessionsService.create({
      tenantId,
      agentId: input.agentId,
      environmentId: input.environmentId,
      title: "",
      vaultIds: [...input.vaultIds],
      agentSnapshot: agentBase as never,
      environmentSnapshot: envSnapshot as never,
      metadata: meta as never,
    });

    const chatId = telegramChatId(meta);

    // Attach the reply observer BEFORE kicking the turn so no early
    // agent.message events are missed.
    attachTelegramReply({
      sessionId: session.id,
      chatId,
      client: this.opts.client,
      subscribe: this.hubSubscribe,
      log,
    });

    await this.opts.sessionRouter.appendEvent(session.id, toUserMessage(input.initialEvent));

    return { sessionId: session.id as SessionId };
  }

  async resume(_userId: UserId, sessionId: SessionId, event: SessionEventInput): Promise<void> {
    const session = await this.opts.sessionsService.getById({ sessionId });
    if (!session) throw new Error(`session_not_found: ${sessionId}`);
    const chatId = telegramChatId(session.metadata);

    // One-shot observer per turn — attaching fresh on every resume is
    // correct (the previous turn's observer already unsubscribed itself on
    // its terminal event).
    attachTelegramReply({
      sessionId,
      chatId,
      client: this.opts.client,
      subscribe: this.hubSubscribe,
      log,
    });

    await this.opts.sessionRouter.appendEvent(sessionId, toUserMessage(event));
  }

  async pause(userId: UserId, sessionId: SessionId): Promise<void> {
    // Sandbox pause/resume is a Cloudflare-Containers-specific cost
    // optimization — the self-host Node runtime doesn't provision
    // per-session containers the same way, so there's nothing to pause
    // here yet. Mirrors InProcessSessionCreator.pause's no-op.
    log.warn(
      { op: "node_telegram.pause.unsupported", session_id: sessionId, user_id: userId },
      "session pause requested but not supported on the self-host Node runtime",
    );
  }
}
