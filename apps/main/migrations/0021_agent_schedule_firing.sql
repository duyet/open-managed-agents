-- Firing columns for agent_schedules (issue #77).
--
-- The CRUD scaffold (routes/schedules.ts) created rows but nothing fired
-- them. These columns let a per-minute cron tick select due schedules,
-- claim each row idempotently (CAS on next_run_at), launch a session, and
-- record the outcome.
--
-- Single shared D1, tenant-scoped rows — no new shard DB (issue design
-- constraint). agent_schedules lives in MAIN_DB.

ALTER TABLE agent_schedules ADD COLUMN environment_id TEXT;
ALTER TABLE agent_schedules ADD COLUMN user_id TEXT;
ALTER TABLE agent_schedules ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC';
ALTER TABLE agent_schedules ADD COLUMN next_run_at TEXT;
ALTER TABLE agent_schedules ADD COLUMN last_run_at TEXT;
ALTER TABLE agent_schedules ADD COLUMN last_run_status TEXT;
ALTER TABLE agent_schedules ADD COLUMN last_run_error TEXT;
ALTER TABLE agent_schedules ADD COLUMN last_session_id TEXT;

-- Due-selection index: the tick queries WHERE enabled = 1 AND next_run_at <= ?.
CREATE INDEX IF NOT EXISTS idx_agent_schedules_due ON agent_schedules(enabled, next_run_at);
