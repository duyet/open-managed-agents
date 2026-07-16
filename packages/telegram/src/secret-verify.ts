// Constant-time verification of the `X-Telegram-Bot-Api-Secret-Token`
// webhook header. Runtime-agnostic (no Node crypto import) so it works
// identically on Cloudflare Workers and self-host Node.

/**
 * Compares two strings in constant time (relative to the longer input).
 * Always does the same amount of work regardless of where a mismatch
 * occurs, including when the lengths differ, so timing can't leak how
 * much of the secret an attacker has guessed correctly.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  const maxLen = Math.max(aBytes.length, bBytes.length);

  let diff = aBytes.length === bBytes.length ? 0 : 1;
  for (let i = 0; i < maxLen; i++) {
    const av = i < aBytes.length ? aBytes[i] : 0;
    const bv = i < bBytes.length ? bBytes[i] : 0;
    diff |= av ^ bv;
  }
  return diff === 0;
}

export interface VerifyTelegramWebhookSecretOpts {
  /** The secret configured for this deployment (e.g. env.TELEGRAM_WEBHOOK_SECRET).
   *  Falsy (unset/empty) disables verification — passthrough. */
  configuredSecret?: string;
  /** The `X-Telegram-Bot-Api-Secret-Token` header value from the request. */
  headerValue?: string | null;
}

export interface VerifyTelegramWebhookSecretResult {
  ok: boolean;
  status: 200 | 401;
}

/**
 * Verifies a Telegram webhook request's secret token header.
 *
 * - No secret configured → passthrough (ok, 200) — preserves current
 *   behavior for deployments that haven't set one up.
 * - Secret configured but header missing or mismatched → 401.
 * - Secret configured and header matches → ok, 200.
 */
export function verifyTelegramWebhookSecret(
  opts: VerifyTelegramWebhookSecretOpts,
): VerifyTelegramWebhookSecretResult {
  if (!opts.configuredSecret) return { ok: true, status: 200 };
  if (!opts.headerValue) return { ok: false, status: 401 };
  if (!constantTimeEqual(opts.configuredSecret, opts.headerValue)) return { ok: false, status: 401 };
  return { ok: true, status: 200 };
}
