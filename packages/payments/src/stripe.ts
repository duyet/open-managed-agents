// Minimal, dependency-free Stripe client (issue #74).
//
// Stripe's official SDK pulls in Node builtins that don't bundle cleanly into
// a Workers isolate. The surface we need — Checkout Session creation and
// webhook signature verification — is plain `fetch` + Web Crypto HMAC, so we
// implement just that here. Runs identically on Cloudflare Workers and Node.

export class StripeSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StripeSignatureError";
  }
}

export interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
  [k: string]: unknown;
}

const encoder = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Constant-time compare of two equal-purpose hex strings. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return toHex(sig);
}

/** Parse a `Stripe-Signature` header (`t=...,v1=...,v1=...`). */
function parseSigHeader(header: string): { t: number; v1: string[] } {
  let t = 0;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=");
    if (k === "t") t = Number(v);
    else if (k === "v1" && v) v1.push(v);
  }
  return { t, v1 };
}

/**
 * Verify a Stripe webhook signature and return the parsed event.
 *
 * Mirrors `stripe.webhooks.constructEvent`: the signed payload is
 * `${t}.${rawBody}`, HMAC-SHA256'd with the endpoint's signing secret. We
 * accept if any `v1` scheme signature matches and the timestamp is within
 * `toleranceSec` (replay protection). Throws `StripeSignatureError` otherwise.
 *
 * `rawBody` MUST be the exact bytes Stripe sent — never a re-serialized JSON
 * object, or the HMAC will not match.
 */
export async function verifyWebhookSignature(
  rawBody: string,
  sigHeader: string | null | undefined,
  secret: string,
  opts: { toleranceSec?: number; nowSec?: number } = {},
): Promise<StripeEvent> {
  if (!sigHeader) throw new StripeSignatureError("Missing Stripe-Signature header");
  if (!secret) throw new StripeSignatureError("Missing webhook signing secret");

  const { t, v1 } = parseSigHeader(sigHeader);
  if (!t || v1.length === 0) {
    throw new StripeSignatureError("Malformed Stripe-Signature header");
  }

  const tolerance = opts.toleranceSec ?? 300;
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > tolerance) {
    throw new StripeSignatureError("Timestamp outside tolerance window");
  }

  const expected = await hmacSha256Hex(secret, `${t}.${rawBody}`);
  const matched = v1.some((candidate) => timingSafeEqual(candidate, expected));
  if (!matched) throw new StripeSignatureError("Signature mismatch");

  try {
    return JSON.parse(rawBody) as StripeEvent;
  } catch {
    throw new StripeSignatureError("Event body is not valid JSON");
  }
}

/** Compute the `Stripe-Signature` header value for a payload — used by tests
 *  to forge a genuine signature, and available for outbound relays. */
export async function signPayload(
  rawBody: string,
  secret: string,
  tSec: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const v1 = await hmacSha256Hex(secret, `${tSec}.${rawBody}`);
  return `t=${tSec},v1=${v1}`;
}

export interface CheckoutSessionParams {
  mode: "payment" | "subscription";
  priceId: string;
  quantity?: number;
  successUrl: string;
  cancelUrl: string;
  clientReferenceId?: string;
  /** Metadata copied onto the resulting Checkout Session (echoed back on the
   *  webhook so we can attribute credits to a tenant / end-user). */
  metadata?: Record<string, string>;
  /** Stripe Connect: route funds + charge to the creator's connected account
   *  (`acct_*`). When set, the platform is NOT merchant of record. */
  stripeAccount?: string;
  /** Platform take-rate in the smallest currency unit, applied as an
   *  application fee on a Connect charge. */
  applicationFeeAmount?: number;
}

export interface CheckoutSession {
  id: string;
  url: string | null;
}

export class StripeClient {
  constructor(
    private readonly secretKey: string,
    private readonly apiBase = "https://api.stripe.com",
  ) {}

  async createCheckoutSession(params: CheckoutSessionParams): Promise<CheckoutSession> {
    const form = new URLSearchParams({
      mode: params.mode,
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      "line_items[0][price]": params.priceId,
      "line_items[0][quantity]": String(params.quantity ?? 1),
    });
    if (params.clientReferenceId) form.set("client_reference_id", params.clientReferenceId);
    for (const [k, v] of Object.entries(params.metadata ?? {})) {
      form.set(`metadata[${k}]`, v);
    }
    if (params.mode === "subscription" && params.applicationFeeAmount != null) {
      form.set("subscription_data[application_fee_percent]", "0");
    }
    if (params.mode === "payment" && params.applicationFeeAmount != null) {
      form.set("payment_intent_data[application_fee_amount]", String(params.applicationFeeAmount));
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    };
    // Stripe Connect direct charge on the creator's account.
    if (params.stripeAccount) headers["Stripe-Account"] = params.stripeAccount;

    const res = await fetch(`${this.apiBase}/v1/checkout/sessions`, {
      method: "POST",
      headers,
      body: form,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Stripe checkout create failed (${res.status}): ${body.slice(0, 300)}`);
    }
    const json = (await res.json()) as { id: string; url: string | null };
    return { id: json.id, url: json.url };
  }
}
