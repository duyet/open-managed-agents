-- 0006_tenant_invites.sql — tenant teammate invites (issue #175). Mirrors the
-- CF hand-written migration apps/main/migrations/0031_tenant_invites.sql.
-- Hand-authored (no drizzle snapshot), matching 0002-0005 in this folder.
CREATE TABLE "tenant_invites" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"token" text NOT NULL,
	"invited_by" text,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"accepted_at" bigint,
	"accepted_by" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_tenant_invites_token" ON "tenant_invites" USING btree ("token");--> statement-breakpoint
CREATE INDEX "idx_tenant_invites_tenant" ON "tenant_invites" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_tenant_invites_tenant_email" ON "tenant_invites" USING btree ("tenant_id","email","status");
