ALTER TABLE "sessions" ADD COLUMN "stop_reason" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "tool_call_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "message_count" integer DEFAULT 0 NOT NULL;