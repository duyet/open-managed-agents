ALTER TABLE `sessions` ADD `stop_reason` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `tool_call_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `message_count` integer DEFAULT 0 NOT NULL;