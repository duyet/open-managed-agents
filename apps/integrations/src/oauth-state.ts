// Shared OAuth state / CSRF helper for the unified "Connect" install flow.
//
// Every provider's OAuth handshake needs the same three things:
//   1. a signed, tamper-proof `state` param that survives the round-trip to
//      the provider's consent page and back (CSRF protection);
//   2. an expiry so a stolen/replayed state can't be redeemed forever;
//   3. a place to stash where the user should land afterwards (return_url)
//      plus which tenant + provider the flow belongs to.
//
// Before this, each provider baked its own state encoding into its install
// bridge. This module centralizes the primitive so a new provider only has to
// register a client id + scopes (see oauth-unified.ts) — CSRF/state handling
// is done once, here, and covered by route tests.
//
// Uses Web Crypto (HMAC-SHA256) so it runs byte-identically on Cloudflare
// Workers and self-host Node. No provider SDKs, no Node builtins.

export interface OAuthStatePayload {
  /** Provider id the flow belongs to (e.g. "linear" | "github" | "slack"). */
  provider: string;
  /** User that initiated the connect flow (owns the resulting vault). */
  userId: string;
  /** Tenant that initiated the connect flow. */
  tenantId: string;
  /** Where to redirect the browser once the token is stored. */
  returnUrl: string;
  /** Random CSRF nonce — the un-guessable part an attacker can't forge. */
  nonce: string;
  /** Unix seconds after which the state is rejected. */
  exp: number;
}

/** Fields a caller supplies; nonce + exp are minted for them. */
export interface MintStateInput {
  provider: string;
  userId: string;
  tenantId: string;
  returnUrl: string;
  /** Time-to-live in seconds. Defaults to 600 (10 minutes). */
  ttlSeconds?: number;
}

const DEFAULT_TTL_SECONDS = 600;

// base64url without padding — safe to drop straight into a query string.
function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const encoder = new TextEncoder();

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    // Bind the key to a distinct label so it can't be confused with the JWT
    // signing use of the same PLATFORM_ROOT_SECRET seed.
    encoder.encode(`oauth-state:${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return new Uint8Array(sig);
}

/** Constant-time compare — avoids leaking signature bytes via timing. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Mint an opaque, signed `state` string. Format is `<payloadB64>.<sigB64>`
 * where the signature is HMAC-SHA256 over the payload segment. The payload is
 * readable (base64url JSON) but not forgeable without the secret.
 */
export async function mintOAuthState(secret: string, input: MintStateInput): Promise<string> {
  const payload: OAuthStatePayload = {
    provider: input.provider,
    userId: input.userId,
    tenantId: input.tenantId,
    returnUrl: input.returnUrl,
    nonce: toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
    exp: Math.floor(Date.now() / 1000) + (input.ttlSeconds ?? DEFAULT_TTL_SECONDS),
  };
  const payloadSeg = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const sigSeg = toBase64Url(await hmac(secret, payloadSeg));
  return `${payloadSeg}.${sigSeg}`;
}

export type VerifyStateResult =
  | { ok: true; payload: OAuthStatePayload }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

/**
 * Verify + decode a `state` string. Rejects tampered payloads (bad_signature),
 * expired states, and anything that doesn't parse (malformed). On success the
 * decoded payload — including the CSRF nonce — is returned so the caller can
 * cross-check `provider` against the callback route.
 */
export async function verifyOAuthState(
  secret: string,
  state: string,
): Promise<VerifyStateResult> {
  const parts = state.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  const [payloadSeg, sigSeg] = parts;

  let expectedSig: Uint8Array;
  let providedSig: Uint8Array;
  try {
    expectedSig = await hmac(secret, payloadSeg);
    providedSig = fromBase64Url(sigSeg);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!timingSafeEqual(expectedSig, providedSig)) return { ok: false, reason: "bad_signature" };

  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromBase64Url(payloadSeg))) as OAuthStatePayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    typeof payload?.provider !== "string" ||
    typeof payload?.userId !== "string" ||
    typeof payload?.tenantId !== "string" ||
    typeof payload?.returnUrl !== "string" ||
    typeof payload?.nonce !== "string" ||
    typeof payload?.exp !== "number"
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (Math.floor(Date.now() / 1000) >= payload.exp) return { ok: false, reason: "expired" };

  return { ok: true, payload };
}
