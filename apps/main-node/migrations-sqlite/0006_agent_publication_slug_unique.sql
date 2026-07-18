-- 0006_agent_publication_slug_unique.sql — unique index on
-- agent_publication.slug (issue #268). Mirrors
-- apps/main/migrations/0030_agent_publication_slug_unique.sql — see that
-- file's comment for the full rationale (global uniqueness, dedupe-then-index).
UPDATE `agent_publication`
SET `slug` = `slug` || '-dup-' || substr(`id`, 1, 8)
WHERE `id` IN (
	SELECT `id` FROM (
		SELECT `id`, ROW_NUMBER() OVER (
			PARTITION BY `slug` ORDER BY `created_at` ASC, `id` ASC
		) AS rn
		FROM `agent_publication`
	)
	WHERE rn > 1
);
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_agent_publication_slug`;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_publication_slug_unique` ON `agent_publication` (`slug`);
