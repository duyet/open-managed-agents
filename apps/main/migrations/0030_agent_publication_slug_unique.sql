-- 0030_agent_publication_slug_unique.sql — unique index on
-- agent_publication.slug (issue #268).
--
-- /p/:slug has no tenant in the URL, so the Postgres schema
-- (packages/db-schema/src/node-pg/cf-auth-publications.ts) already enforces
-- a GLOBAL unique index on slug. D1 never got the matching constraint —
-- two tenants could publish the same slug and getBySlug's "whichever row
-- comes back first" resolution silently shadows one bot with another.
--
-- Dedupe first: keep the oldest row per slug (by created_at, then id as a
-- tiebreak), rename every other colliding row's slug so CREATE UNIQUE INDEX
-- doesn't fail on pre-existing duplicates. Renamed rows keep working under
-- their new slug; their old public URL 404s instead of silently resolving
-- to a different tenant's bot, which is the safer failure mode.
UPDATE agent_publication
SET slug = slug || '-dup-' || substr(id, 1, 8)
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY slug ORDER BY created_at ASC, id ASC
    ) AS rn
    FROM agent_publication
  )
  WHERE rn > 1
);

DROP INDEX IF EXISTS idx_agent_publication_slug;
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_publication_slug_unique ON agent_publication(slug);
