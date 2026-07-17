-- agent_publication was defined in packages/db-schema/src/cf-auth/publications.ts
-- (issue #72) but never migrated onto Node self-host SQLite — CF ships it as
-- a hand-written D1 migration; Node's node-sqlite barrel re-exports cf-auth
-- and so already declares this table in its drizzle schema, but no migration
-- file ever created it here. Without it, publications (and therefore the
-- /p/:slug public surface, issue #226) cannot work on the SQLite backend at
-- all. This migration only adds the missing table — no other schema drift.
CREATE TABLE `agent_publication` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`agent_version` integer NOT NULL,
	`slug` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`description` text,
	`avatar_url` text,
	`visibility` text DEFAULT 'public' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`greeting` text,
	`suggested_prompts` text,
	`pricing_ref` text,
	`rate_limit_ref` text,
	`environment_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_agent_publication_tenant` ON `agent_publication` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_publication_slug` ON `agent_publication` (`slug`);--> statement-breakpoint
CREATE INDEX `idx_agent_publication_agent` ON `agent_publication` (`tenant_id`,`agent_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_publication_tenant_created_id` ON `agent_publication` (`tenant_id`,`created_at`,`id`);
