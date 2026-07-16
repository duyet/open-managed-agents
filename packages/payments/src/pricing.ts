// Per-publication pricing model (issue #74).
//
// A publication carries an optional `pricing_ref` FK into `publication_pricing`.
// When absent (or mode === "free"), the public chat surface is ungated.
// Otherwise the platform meters the end-user's credit wallet on each turn.
//
// All amounts are expressed in **credits** — an integer platform-internal
// unit. The Stripe layer maps fiat → credits at top-up time via
// `included_credits` on the pricing row (or a Checkout line-item quantity),
// so the metering hot-path never touches currency math.

export type PricingMode = "free" | "per_message" | "per_1k_tokens" | "subscription";

export const PRICING_MODES: readonly PricingMode[] = [
  "free",
  "per_message",
  "per_1k_tokens",
  "subscription",
] as const;

export function isPricingMode(v: unknown): v is PricingMode {
  return typeof v === "string" && (PRICING_MODES as readonly string[]).includes(v);
}

export interface PublicationPricing {
  id: string;
  tenant_id: string;
  publication_id: string;
  mode: PricingMode;
  /** Credits charged per unit: per message, or per 1k tokens. Ignored for
   *  `free` / `subscription`. */
  price_amount: number;
  /** ISO-4217 currency the `stripe_price_id` is denominated in (display only). */
  currency: string;
  /** Credits granted on a successful top-up / subscription invoice. */
  included_credits: number;
  /** Stripe Price id used for Checkout / subscriptions (null when unset). */
  stripe_price_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Real usage observed for a completed turn (from span.model_request_end
 *  token totals, and the turn's message count). */
export interface TurnUsage {
  messages: number;
  tokens: number;
}

/**
 * Cost in **credits** for one completed turn under a pricing mode.
 *
 * - `free`         → always 0
 * - `subscription` → 0 (access gated by an active subscription, not metered)
 * - `per_message`  → price_amount × messages
 * - `per_1k_tokens`→ price_amount × ceil(tokens / 1000)
 *
 * Never returns a negative or fractional value; callers debit whole credits.
 */
export function computeTurnCost(
  mode: PricingMode,
  priceAmount: number,
  usage: TurnUsage,
): number {
  const price = Math.max(0, Math.floor(priceAmount || 0));
  switch (mode) {
    case "free":
    case "subscription":
      return 0;
    case "per_message":
      return price * Math.max(0, Math.floor(usage.messages || 0));
    case "per_1k_tokens":
      return price * Math.ceil(Math.max(0, usage.tokens || 0) / 1000);
    default:
      return 0;
  }
}

/** Whether a mode debits the credit wallet per turn (vs. subscription/free). */
export function isMetered(mode: PricingMode): boolean {
  return mode === "per_message" || mode === "per_1k_tokens";
}
