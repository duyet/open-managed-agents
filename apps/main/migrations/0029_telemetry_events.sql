-- 0029_telemetry_events.sql — anonymous CLI usage telemetry (public,
-- unauthenticated ingest via POST /v1/telemetry/events).

CREATE TABLE IF NOT EXISTS telemetry_events (
  id TEXT PRIMARY KEY NOT NULL,
  event TEXT NOT NULL,
  command TEXT,
  cli_version TEXT,
  os TEXT,
  arch TEXT,
  node_version TEXT,
  machine_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_telemetry_created_at ON telemetry_events (created_at);
CREATE INDEX IF NOT EXISTS idx_telemetry_command ON telemetry_events (command);
CREATE INDEX IF NOT EXISTS idx_telemetry_os ON telemetry_events (os);
