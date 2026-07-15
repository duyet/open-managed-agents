export type WebhookEventType =
  | "session.created"
  | "session.completed"
  | "session.error"
  | "box.created"
  | "box.destroyed"
  | "box.error"
  | "provider.healthy"
  | "provider.unhealthy";

export type AgentHookPoint =
  | "pre_tool"
  | "post_tool"
  | "pre_model"
  | "post_model"
  | "session_start"
  | "session_end";

export interface WebhookConfig {
  id: string;
  url: string;
  secret?: string;
  events: WebhookEventType[];
  agent_hooks?: AgentHookPoint[];
  retry_count: number;
  timeout_ms: number;
  tenant_id?: string;
  created_at?: string;
  updated_at?: string;
}

export interface WebhookDelivery {
  id: string;
  webhook_id: string;
  event: WebhookEventType;
  url: string;
  status: "pending" | "delivered" | "failed";
  status_code?: number;
  attempt: number;
  max_attempts: number;
  error?: string;
  duration_ms: number;
  created_at: string;
}

export interface WebhookPayload {
  event: WebhookEventType;
  timestamp: string;
  webhook_id: string;
  delivery_id: string;
  data: unknown;
}

export interface AgentHookPayload {
  hook_point: AgentHookPoint;
  timestamp: string;
  session_id: string;
  agent_id: string;
  data: Record<string, unknown>;
}
