// RFC 7636 PKCE helpers. Web Crypto + btoa only (crypto.getRandomValues,
// crypto.subtle.digest, btoa) so this package stays instantiable in Node
// 18+, browser, or workerd alike — no node:crypto / node:buffer import.

/** Base64url-encode bytes (no padding), per RFC 7636 §A. */
export function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface PkcePair {
  /** 43-char base64url random string — kept server-side, never leaves the
   *  connect flow until the token exchange request. */
  verifier: string;
  /** S256(verifier) — sent in the authorize redirect. */
  challenge: string;
}

/** Generate a fresh PKCE verifier + S256 challenge pair. */
export async function generatePkcePair(): Promise<PkcePair> {
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const verifier = base64url(verifierBytes); // 43 base64url chars

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = base64url(new Uint8Array(digest));

  return { verifier, challenge };
}

/** Generate an opaque `state` value for CSRF protection across the redirect. */
export function generateState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}
