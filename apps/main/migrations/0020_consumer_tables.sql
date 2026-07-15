-- 0020_consumer_tables.sql — consumer auth, metering, and agent schedules
--
-- Consumer tables for the public-facing API: magic-link auth, credit-based
-- metering, and per-agent cron schedules.

-- Consumers: public-facing users authenticated via magic links
CREATE TABLE IF NOT EXISTS consumers (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Magic links: one-time tokens for email-based sign-in
CREATE TABLE IF NOT EXISTS magic_links (
  token TEXT PRIMARY KEY,
  consumer_id TEXT NOT NULL REFERENCES consumers(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_magic_links_consumer ON magic_links(consumer_id);

-- Consumer sessions: bearer tokens issued after magic link verification
CREATE TABLE IF NOT EXISTS consumer_sessions (
  token TEXT PRIMARY KEY,
  consumer_id TEXT NOT NULL REFERENCES consumers(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_consumer_sessions_consumer ON consumer_sessions(consumer_id);

-- Consumer credits: per-consumer, per-agent credit balance
CREATE TABLE IF NOT EXISTS consumer_credits (
  id TEXT PRIMARY KEY,
  consumer_id TEXT NOT NULL REFERENCES consumers(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  credits_remaining INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_consumer_credits_consumer ON consumer_credits(consumer_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_consumer_credits_consumer_agent ON consumer_credits(consumer_id, agent_id);

-- Credit usage log: audit trail for all credit deductions
CREATE TABLE IF NOT EXISTS credit_usage_log (
  id TEXT PRIMARY KEY,
  consumer_id TEXT NOT NULL REFERENCES consumers(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  credits_used INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_credit_usage_log_consumer ON credit_usage_log(consumer_id, created_at);

-- Agent schedules: cron-triggered session creation for agents
CREATE TABLE IF NOT EXISTS agent_schedules (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  cron_expression TEXT NOT NULL,
  input TEXT NOT NULL,
  max_sessions INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_schedules_agent ON agent_schedules(agent_id, tenant_id);
