-- 0007_schedules.sql — agent schedules + deployments (issue #262).
--
-- Ports the Cloudflare D1 schemas
-- (apps/main/migrations/0020_consumer_tables.sql agent_schedules +
-- 0021_agent_schedule_firing.sql firing columns, and
-- 0023_deployments.sql) into the self-host Node control-plane DB so the
-- shared scheduled-agent-runs and scheduled-deployment-runs ticks can select
-- + fire schedules here too. Single fresh CREATE per table rather than a
-- table-then-ALTER chain since Node never had the base tables.
--
-- Numbered 0007 because the sqlite dialect already has a 0006
-- (0006_agent_publication_slug_unique); the postgres dialect's equivalent is
-- 0006_schedules. Timestamps + next_run_at are ISO-8601 TEXT (matching CF);
-- enabled / max_sessions are integers. Deployment CRUD routes are still
-- CF-only, so `deployments` is typically empty on Node; the tick then reads
-- zero due rows rather than throwing on a missing table.
CREATE TABLE IF NOT EXISTS `agent_schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`cron_expression` text NOT NULL,
	`input` text NOT NULL,
	`environment_id` text,
	`user_id` text,
	`timezone` text NOT NULL DEFAULT 'UTC',
	`next_run_at` text,
	`last_run_at` text,
	`last_run_status` text,
	`last_run_error` text,
	`last_session_id` text,
	`max_sessions` integer NOT NULL DEFAULT 1,
	`enabled` integer NOT NULL DEFAULT 1,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_agent_schedules_agent` ON `agent_schedules` (`agent_id`,`tenant_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_agent_schedules_due` ON `agent_schedules` (`enabled`,`next_run_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `deployments` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`agent_id` text NOT NULL,
	`agent_version` integer,
	`environment_id` text NOT NULL,
	`vault_ids` text NOT NULL DEFAULT '[]',
	`memory_store_ids` text NOT NULL DEFAULT '[]',
	`initial_message` text NOT NULL,
	`trigger` text NOT NULL DEFAULT '{"type":"manual"}',
	`hook_token` text,
	`user_id` text,
	`enabled` integer NOT NULL DEFAULT 1,
	`next_run_at` text,
	`last_run_at` text,
	`last_run_status` text,
	`last_run_error` text,
	`last_session_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_deployments_tenant` ON `deployments` (`tenant_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_deployments_due` ON `deployments` (`enabled`,`next_run_at`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_deployments_hook_token` ON `deployments` (`hook_token`);
