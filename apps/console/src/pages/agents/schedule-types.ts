/** Agent schedule wire shape — mirrors `packages/http-routes/src/schedules/index.ts`. */

export interface AgentSchedule {
  id: string;
  agent_id: string;
  cron_expression: string;
  input: string;
  environment_id: string;
  timezone: string;
  next_run_at: string | null;
  last_run_at?: string | null;
  last_run_status?: string | null;
  last_run_error?: string | null;
  last_session_id?: string | null;
  max_sessions: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}
