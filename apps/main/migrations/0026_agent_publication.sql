-- 0026_agent_publication.sql — the `agent_publication` table itself.
--
-- Found while fixing workers-pool test D1 schema drift (issue #214):
-- packages/db-schema/src/cf-auth/publications.ts (added by #72/#106) was
-- never turned into a CREATE TABLE migration — only its later ALTER TABLE
-- (0028_publication_environment.sql, environment_id) exists. Every real
-- deployment already publishes agents today, so this table exists there
-- some other way; CREATE TABLE IF NOT EXISTS keeps this additive/idempotent
-- like every other post-0002 migration in this directory, so a real deploy
-- applying it is a no-op rather than an error.
--
-- Column set mirrors publications.ts exactly, MINUS environment_id, which
-- keeps its own dedicated 0028 migration so migration history stays
-- accurate (that column really was added later, by issue #225).

CREATE TABLE IF NOT EXISTS agent_publication (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_version INTEGER NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  description TEXT,
  avatar_url TEXT,
  visibility TEXT NOT NULL DEFAULT 'public',
  status TEXT NOT NULL DEFAULT 'draft',
  greeting TEXT,
  suggested_prompts TEXT,
  pricing_ref TEXT,
  rate_limit_ref TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_publication_tenant ON agent_publication(tenant_id);
CREATE INDEX IF NOT EXISTS idx_agent_publication_slug ON agent_publication(slug);
CREATE INDEX IF NOT EXISTS idx_agent_publication_agent ON agent_publication(tenant_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_publication_tenant_created_id ON agent_publication(tenant_id, created_at, id);
