CREATE TABLE `consumers` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`auth_provider` text DEFAULT 'email_otp' NOT NULL,
	`tenant_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `consumers_email_unique` ON `consumers` (`email`);--> statement-breakpoint
CREATE TABLE `magic_links` (
	`token` text PRIMARY KEY NOT NULL,
	`consumer_id` text NOT NULL,
	`expires_at` text NOT NULL,
	`used` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_magic_links_consumer` ON `magic_links` (`consumer_id`);--> statement-breakpoint
CREATE TABLE `consumer_sessions` (
	`token` text PRIMARY KEY NOT NULL,
	`consumer_id` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_consumer_sessions_consumer` ON `consumer_sessions` (`consumer_id`);--> statement-breakpoint
CREATE TABLE `consumer_publications` (
	`id` text PRIMARY KEY NOT NULL,
	`consumer_id` text NOT NULL,
	`publication_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_consumer_publications_uniq` ON `consumer_publications` (`consumer_id`,`publication_id`);--> statement-breakpoint
CREATE INDEX `idx_consumer_publications_pub` ON `consumer_publications` (`publication_id`,`tenant_id`);--> statement-breakpoint
CREATE INDEX `idx_consumer_publications_tenant` ON `consumer_publications` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `publication_pricing` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`publication_id` text NOT NULL,
	`mode` text DEFAULT 'free' NOT NULL,
	`price_amount` integer DEFAULT 0 NOT NULL,
	`currency` text DEFAULT 'usd' NOT NULL,
	`included_credits` integer DEFAULT 0 NOT NULL,
	`stripe_price_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_publication_pricing_publication` ON `publication_pricing` (`publication_id`);--> statement-breakpoint
CREATE INDEX `idx_publication_pricing_tenant` ON `publication_pricing` (`tenant_id`);
