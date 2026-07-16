-- 0021_consumer_payments.sql — creator-facing paywall for published agents (#74)
--
-- Consumer-billing stream, kept SEPARATE from the operator infra-cost
-- `usage_events` (seconds) stream. Single shared D1, tenant-scoped rows;
-- keyed by end_user_id. All tables are additive.

-- Per-publication pricing. `pricing_ref` on agent_publication points here.
CREATE TABLE IF NOT EXISTS publication_pricing (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  publication_id TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'free',            -- free | per_message | per_1k_tokens | subscription
  price_amount INTEGER NOT NULL DEFAULT 0,      -- credits per unit
  currency TEXT NOT NULL DEFAULT 'usd',
  included_credits INTEGER NOT NULL DEFAULT 0,  -- credits granted per top-up / invoice
  stripe_price_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_publication_pricing_publication
  ON publication_pricing(publication_id);
CREATE INDEX IF NOT EXISTS idx_publication_pricing_tenant
  ON publication_pricing(tenant_id);

-- End-user credit wallet: append-only ledger. Balance = SUM(delta).
CREATE TABLE IF NOT EXISTS end_user_credit_ledger (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  end_user_id TEXT NOT NULL,
  delta INTEGER NOT NULL,                        -- +top-up / −usage
  reason TEXT NOT NULL,
  session_id TEXT,
  publication_id TEXT,
  stripe_event_id TEXT,                          -- set for top-up credits (dedupe)
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_eucl_wallet
  ON end_user_credit_ledger(tenant_id, end_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_eucl_publication
  ON end_user_credit_ledger(tenant_id, publication_id);

-- Cached balance for hot-path gate reads (SUM(delta) materialized).
CREATE TABLE IF NOT EXISTS end_user_balance (
  tenant_id TEXT NOT NULL,
  end_user_id TEXT NOT NULL,
  balance INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, end_user_id)
);

-- Active subscriptions (populated by invoice.paid / subscription webhooks).
CREATE TABLE IF NOT EXISTS end_user_subscription (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  end_user_id TEXT NOT NULL,
  publication_id TEXT,
  stripe_subscription_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',         -- active | canceled
  current_period_end TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_eus_wallet
  ON end_user_subscription(tenant_id, end_user_id);

-- Webhook idempotency: processed Stripe event ids (dedupe redelivery).
CREATE TABLE IF NOT EXISTS stripe_processed_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at TEXT NOT NULL
);
