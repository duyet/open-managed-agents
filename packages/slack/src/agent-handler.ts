import type { SessionCreator } from "@duyet/oma-integrations-core";

export interface SlackMessageEvent {
  teamId: string;
  channelId: string;
  userId: string;
  threadTs?: string;
  text: string;
  botToken: string;
}

export interface SlackAgentHandlerConfig {
  sessions: SessionCreator;
  agentId: string;
  environmentId: string;
  publicationId: string;
  vaultIds: string[];
}

export async function handleSlackMessage(
  event: SlackMessageEvent,
  config: SlackAgentHandlerConfig,
): Promise<string> {
  const sessionEvent = {
    type: "user.message" as const,
    content: [{ type: "text" as const, text: event.text }],
    metadata: {
      slack: {
        workspaceId: event.teamId,
        channelId: event.channelId,
        threadTs: event.threadTs ?? null,
        userId: event.userId,
        eventKind: "message",
      },
    },
  };

  const created = await config.sessions.create({
    userId: event.userId,
    agentId: config.agentId,
    environmentId: config.environmentId,
    vaultIds: config.vaultIds,
    mcpServers: [],
    metadata: { slack: { channelId: event.channelId } },
    initialEvent: sessionEvent,
  });

  return created.sessionId;
}
