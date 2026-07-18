-- Tenant teammate invites (issue #175). A tenant already carries roles on
-- `membership`, but there was no way to add a second person to a workspace.
-- An invite is an email + role + opaque token with an expiry; accepting it
-- (as the signed-in user whose email matches) writes a `membership` row.
--
-- Lives in the shared control-plane D1 (MAIN_DB), next to tenant/membership,
-- so accept can write the membership in the same store. Tenant-scoped rows.

CREATE TABLE IF NOT EXISTS tenant_invites (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  -- Lowercased invitee email.
  email TEXT NOT NULL,
  -- Role granted on accept: 'admin' | 'member' ('owner' is reserved).
  role TEXT NOT NULL DEFAULT 'member',
  -- 'pending' | 'accepted' | 'revoked'.
  status TEXT NOT NULL DEFAULT 'pending',
  -- Opaque acceptance secret; unique so a token resolves an invite in O(1).
  token TEXT NOT NULL,
  invited_by TEXT,
  -- All timestamps are ms-since-epoch (matches the pagination cursor codec).
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  accepted_by TEXT
);

-- Token lookup on accept/preview: resolve an invite from its token in O(1).
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_invites_token ON tenant_invites(token);

-- List pagination is (created_at, id) DESC scoped to a tenant.
CREATE INDEX IF NOT EXISTS idx_tenant_invites_tenant
  ON tenant_invites(tenant_id, created_at, id);

-- Dedupe lookup: a pending invite for a given (tenant, email).
CREATE INDEX IF NOT EXISTS idx_tenant_invites_tenant_email
  ON tenant_invites(tenant_id, email, status);
