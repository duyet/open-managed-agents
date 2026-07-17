-- See migrations-sqlite/0004_agent_publication.sql: agent_publication was
-- declared in the schema barrel (packages/db-schema/src/node-pg/cf-auth-publications.ts)
-- but never migrated onto Node self-host Postgres. Adds only the missing
-- table (issue #226).
CREATE TABLE "agent_publication" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"agent_version" bigint NOT NULL,
	"slug" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"description" text,
	"avatar_url" text,
	"visibility" text DEFAULT 'public' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"greeting" text,
	"suggested_prompts" text,
	"pricing_ref" text,
	"rate_limit_ref" text,
	"environment_id" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_agent_publication_tenant" ON "agent_publication" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_publication_slug" ON "agent_publication" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "idx_agent_publication_agent" ON "agent_publication" USING btree ("tenant_id","agent_id");--> statement-breakpoint
CREATE INDEX "idx_agent_publication_tenant_created" ON "agent_publication" USING btree ("tenant_id","created_at");
