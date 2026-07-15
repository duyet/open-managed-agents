import type { WebhookDispatcher, AgentHookPoint, AgentHookPayload } from "@duyet/oma-webhooks";

export interface AgentHookConfig {
  hooks: AgentHookPoint[];
  dispatcher: WebhookDispatcher;
}

export async function fireAgentHook(
  hookConfig: AgentHookConfig | undefined,
  hookPoint: AgentHookPoint,
  sessionId: string,
  agentId: string,
  data: Record<string, unknown>,
): Promise<void> {
  if (!hookConfig) return;
  if (!hookConfig.hooks.includes(hookPoint)) return;

  const payload: AgentHookPayload = {
    hook_point: hookPoint,
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    agent_id: agentId,
    data,
  };

  await hookConfig.dispatcher.dispatch(
    "session.completed",
    { hook: payload },
    undefined,
  );
}

export function makePreToolPayload(name: string, args: Record<string, unknown>) {
  return {
    tool: name,
    args,
    timestamp: new Date().toISOString(),
  };
}

export function makePostToolPayload(
  name: string,
  args: Record<string, unknown>,
  result: unknown,
  durationMs: number,
) {
  return {
    tool: name,
    args,
    result,
    duration_ms: durationMs,
    timestamp: new Date().toISOString(),
  };
}
