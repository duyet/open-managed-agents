-- 0032_telemetry_installs.sql — anonymous server-side install / deployment
-- phone-home telemetry (public, unauthenticated ingest via
-- POST /v1/telemetry/ingest).
--
-- Privacy: rows carry ONLY anonymous aggregates — a random locally-persisted
-- instance UUID, the OMA version string, a deployment-kind enum, numeric
-- counts / durations (ms), a JSON tally of sandbox-provider launches, and a
-- JSON array of model id strings (names only). No PII, no prompt/message
-- content, no tenant/agent names or ids, no file paths, no tokens.

CREATE TABLE IF NOT EXISTS telemetry_installs (
  id TEXT PRIMARY KEY NOT NULL,
  instance_id TEXT NOT NULL,
  oma_version TEXT,
  deployment_kind TEXT,
  agents_total INTEGER,
  agents_active INTEGER,
  sessions_total INTEGER,
  sessions_running INTEGER,
  session_duration_total_ms INTEGER,
  session_duration_avg_ms INTEGER,
  idle_time_total_ms INTEGER,
  sandbox_launches TEXT,
  model_ids TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_telemetry_installs_instance ON telemetry_installs (instance_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_installs_created_at ON telemetry_installs (created_at);

-- Single-row store for the Cloudflare deployment's stable instance id. The
-- CF phone-home handler has no local filesystem to persist a UUID, so it
-- reads (or seeds) the id here. Node uses a persisted file instead.
CREATE TABLE IF NOT EXISTS telemetry_instance (
  id TEXT PRIMARY KEY NOT NULL,
  instance_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
