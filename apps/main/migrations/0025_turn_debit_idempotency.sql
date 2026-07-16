-- 0025_turn_debit_idempotency.sql — per-turn metering debit guard (#163)
--
-- `per_1k_tokens` publications are metered post-turn: the agent DO debits the
-- real token cost against the end-user wallet when a turn reaches idle. This
-- guard table makes that debit idempotent — a redelivered/duplicate completion
-- signal (or a crash-recovery re-emit of the same turn) must never double-charge.
--
-- `turn_key` is stable per turn across redelivery: `${session_id}:${cumulative
-- total tokens after the turn}`. The debit path inserts the guard row FIRST
-- (INSERT OR IGNORE); only a newly-inserted key proceeds to the ledger write.
-- Separate from `end_user_credit_ledger` so it doesn't touch the crediting /
-- `stripe_event_id` dedupe path.
CREATE TABLE IF NOT EXISTS turn_debits (
  turn_key TEXT PRIMARY KEY,          -- ${session_id}:${cumulative_total_tokens}
  tenant_id TEXT NOT NULL,
  end_user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  publication_id TEXT,
  credits INTEGER NOT NULL,           -- whole credits debited for this turn (>= 0)
  created_at TEXT NOT NULL
);

-- Audit: list a session's metered turns without scanning the ledger.
CREATE INDEX IF NOT EXISTS idx_turn_debits_session
  ON turn_debits(session_id);
