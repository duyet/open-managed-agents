-- Agent deployments — a first-class "deployment" concept (matches the
-- official Claude Console). A deployment binds an agent (optionally pinned
-- to a version) to an environment, credential vaults, memory stores, an
-- initial message, and a trigger, so it can be run repeatedly.
--
-- Triggers: {"type":"manual"} | {"type":"schedule",...} | {"type":"webhook"}.
--   - manual  : POST /v1/deployments/:id/run creates a session.
--   - webhook : an opaque hook_token secures POST /v1/deployment_hooks/:token.
--   - schedule: a per-minute cron tick (scheduled-deployment-runs) fires it,
--               mirroring agent_schedules exactly (CAS advance of next_run_at).
--
-- Single shared control-plane D1 (MAIN_DB), tenant-scoped rows — no new shard
-- DB, same design constraint as agent_schedules.

CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  -- NULL = always run the latest agent version; otherwise pin this version.
  agent_version INTEGER,
  environment_id TEXT NOT NULL,
  -- JSON arrays of ids (default empty).
  vault_ids TEXT NOT NULL DEFAULT '[]',
  memory_store_ids TEXT NOT NULL DEFAULT '[]',
  initial_message TEXT NOT NULL,
  -- JSON trigger object (see header).
  trigger TEXT NOT NULL DEFAULT '{"type":"manual"}',
  -- Opaque per-webhook-deployment secret; NULL for non-webhook triggers.
  hook_token TEXT,
  -- Session owner used when the tick / webhook fires with no interactive user.
  user_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  -- Firing bookkeeping (schedule trigger). Mirrors agent_schedules.
  next_run_at TEXT,
  last_run_at TEXT,
  last_run_status TEXT,
  last_run_error TEXT,
  last_session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- List pagination is (created_at, id) DESC scoped to a tenant.
CREATE INDEX IF NOT EXISTS idx_deployments_tenant ON deployments(tenant_id, created_at, id);

-- Due-selection index for the cron tick: WHERE enabled = 1 AND next_run_at <= ?.
CREATE INDEX IF NOT EXISTS idx_deployments_due ON deployments(enabled, next_run_at);

-- Webhook lookup: resolve a deployment from its opaque hook_token in O(1).
-- SQLite permits multiple NULLs under a UNIQUE index, so non-webhook rows
-- (hook_token = NULL) are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS idx_deployments_hook_token ON deployments(hook_token);
