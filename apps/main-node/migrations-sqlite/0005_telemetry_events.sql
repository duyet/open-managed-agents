-- 0005_telemetry_events.sql — anonymous CLI usage telemetry (public,
-- unauthenticated ingest via POST /v1/telemetry/events).
CREATE TABLE `telemetry_events` (
	`id` text PRIMARY KEY NOT NULL,
	`event` text NOT NULL,
	`command` text,
	`cli_version` text,
	`os` text,
	`arch` text,
	`node_version` text,
	`machine_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_telemetry_created_at` ON `telemetry_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_telemetry_command` ON `telemetry_events` (`command`);--> statement-breakpoint
CREATE INDEX `idx_telemetry_os` ON `telemetry_events` (`os`);
