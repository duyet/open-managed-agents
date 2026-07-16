-- 0022_consumer_guest_publications.sql — issue #73 (consumer accounts)
--
-- Extends the existing consumer realm (0020) rather than introducing a
-- second better-auth instance: the custom magic-link flow already gives us
-- an end-user identity distinct from tenant owners (no `membership` row is
-- ever created for a consumer). This migration adds:
--   1. guest mode — anonymous consumers that can start chatting before
--      committing to an account, then upgrade in place (same consumer id,
--      so history/associations survive the claim).
--   2. a consumer <-> publication join so one consumer can use several of a
--      creator's published agents and creators can list their end-users.

-- Distinguish how a consumer authenticated. Existing rows are email/OTP.
ALTER TABLE consumers ADD COLUMN auth_provider TEXT NOT NULL DEFAULT 'email_otp';
-- Consumers are scoped to the tenant whose publication they signed up
-- through (nullable for legacy rows created before this column existed).
ALTER TABLE consumers ADD COLUMN tenant_id TEXT;

-- consumer <-> publication association (first-seen / last-seen), so a
-- consumer's use of a creator's published agents is listable + isolatable.
CREATE TABLE IF NOT EXISTS consumer_publications (
  id TEXT PRIMARY KEY,
  consumer_id TEXT NOT NULL REFERENCES consumers(id) ON DELETE CASCADE,
  publication_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_consumer_publications_uniq
  ON consumer_publications(consumer_id, publication_id);
CREATE INDEX IF NOT EXISTS idx_consumer_publications_pub
  ON consumer_publications(publication_id, tenant_id);
CREATE INDEX IF NOT EXISTS idx_consumer_publications_tenant
  ON consumer_publications(tenant_id);
