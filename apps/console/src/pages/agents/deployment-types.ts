/** Deployment wire shape — mirrors `toApiDeployment` in
 *  apps/main/src/routes/deployments.ts. */

export type TriggerType = "manual" | "schedule" | "webhook";

export type DeploymentTrigger =
  | { type: "manual" }
  | { type: "schedule"; cron_expression: string; timezone?: string }
  | { type: "webhook" };

export interface Deployment {
  id: string;
  name: string;
  agent_id: string;
  agent_version: number | null;
  environment_id: string;
  vault_ids: string[];
  memory_store_ids: string[];
  initial_message: string;
  trigger: DeploymentTrigger;
  webhook_url?: string;
  enabled: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  last_run_status: string | null;
  last_run_error: string | null;
  last_session_id: string | null;
  created_at: string;
  updated_at: string;
}
