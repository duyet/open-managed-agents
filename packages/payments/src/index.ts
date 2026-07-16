// @duyet/oma-payments — creator-facing paywall for published agents (#74).
//
// Three concerns, one package:
//   - pricing.ts  — per-publication pricing modes + credit cost calculation
//   - stripe.ts   — fetch-only Stripe Checkout + webhook signature verify
//   - ledger.ts   — append-only end-user credit wallet + idempotent crediting
//
// Provider abstraction: `isPaymentsEnabled(env)` is false when
// `PAYMENTS_DISABLED` is set (or Stripe secrets absent), in which case the
// self-host / CI path treats every publication as free — no Stripe dependency
// is required to boot.
//
// TODO(#74, Stripe Connect payouts): `StripeClient.createCheckoutSession`
// already accepts `stripeAccount` + `applicationFeeAmount` for Connect direct
// charges, and `GET /v1/publications/:id/revenue` aggregates consumer spend.
// The onboarding flow that mints a creator's connected `acct_*` (Account
// Links / OAuth) and stores it on the tenant is deferred — it's a full
// dashboard surface disproportionate to this issue. Until then the platform
// is merchant of record and the take-rate is informational.

export * from "./pricing";
export * from "./stripe";
export * from "./ledger";

export interface PaymentsEnv {
  PAYMENTS_DISABLED?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
}

/** Payments are live only when not explicitly disabled and a Stripe secret is
 *  present. When false, callers MUST treat all publications as free. */
export function isPaymentsEnabled(env: PaymentsEnv): boolean {
  if (env.PAYMENTS_DISABLED && env.PAYMENTS_DISABLED !== "0" && env.PAYMENTS_DISABLED !== "false") {
    return false;
  }
  return Boolean(env.STRIPE_SECRET_KEY);
}
