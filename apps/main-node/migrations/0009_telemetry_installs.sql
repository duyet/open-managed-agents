-- 0009_telemetry_installs.sql — anonymous server-side install / deployment
-- phone-home telemetry (public, unauthenticated ingest via
-- POST /v1/telemetry/ingest). Self-host Node (Postgres) counterpart of the
-- Cloudflare oma-auth migration apps/main/migrations/0032_telemetry_installs.sql.
--
-- Privacy: rows carry ONLY anonymous aggregates — a random locally-persisted
-- instance UUID, the OMA version string, a deployment-kind enum, numeric
-- counts / durations (ms), a JSON tally of sandbox-provider launches, and a
-- JSON array of model id strings (names only). No PII, no prompt/message
-- content, no tenant/agent names or ids, no file paths, no tokens.
CREATE TABLE "telemetry_installs" (
	"id" text PRIMARY KEY NOT NULL,
	"instance_id" text NOT NULL,
	"oma_version" text,
	"deployment_kind" text,
	"agents_total" integer,
	"agents_active" integer,
	"sessions_total" integer,
	"sessions_running" integer,
	"session_duration_total_ms" bigint,
	"session_duration_avg_ms" bigint,
	"idle_time_total_ms" bigint,
	"sandbox_launches" text,
	"model_ids" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_telemetry_installs_instance" ON "telemetry_installs" USING btree ("instance_id");--> statement-breakpoint
CREATE INDEX "idx_telemetry_installs_created_at" ON "telemetry_installs" USING btree ("created_at");--> statement-breakpoint
CREATE TABLE "telemetry_instance" (
	"id" text PRIMARY KEY NOT NULL,
	"instance_id" text NOT NULL,
	"created_at" bigint NOT NULL
);
