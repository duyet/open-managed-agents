-- 0024_stripe_event_idempotency.sql — DB-enforced Stripe webhook idempotency
-- (#160) + drop the orphaned consumer-credits system (#159).
--
-- #160: end_user_credit_ledger.stripe_event_id had no uniqueness guarantee,
-- so two concurrent webhook deliveries for the same Stripe event could both
-- pass the check-then-act hasProcessedEvent() guard and double-credit a
-- wallet. This partial unique index makes the DB itself refuse a second row
-- for the same event id; applyEntry (apps/main/src/routes/payments.ts) now
-- inserts with INSERT OR IGNORE and only advances the balance when its own
-- insert actually landed a row.
--
-- #159: consumer_credits (keyed by consumer_id+agent_id) was a disconnected,
-- free-topup-capable credit system that nothing but consumer-metering.ts
-- read — the wallet enforcePaywall/PaymentsService actually reads is
-- end_user_credit_ledger/end_user_balance. credit_usage_log was purely the
-- audit trail for consumer_credits deductions and is equally dead now that
-- its only caller (/credits/deduct) is removed. Dropped together — no
-- backward-compat concerns pre-launch.

CREATE UNIQUE INDEX idx_eucl_stripe_event
  ON end_user_credit_ledger(stripe_event_id) WHERE stripe_event_id IS NOT NULL;

DROP TABLE IF EXISTS consumer_credits;
DROP TABLE IF EXISTS credit_usage_log;
