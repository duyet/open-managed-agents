// At-rest encryption wiring for the self-host vault credential store
// (issue #187).
//
// The CF deployment has always enforced this: buildServices
// (packages/services/src/index.ts) throws without PLATFORM_ROOT_SECRET and
// wires WebCryptoAesGcm(secret, "credentials.auth") into the credential
// repo. The self-host Node composition root never passed a crypto instance,
// so SqlCredentialRepo silently fell back to its identity (plaintext)
// passthrough — vault credentials landed in ./data/oma.db as raw JSON
// despite README/CLAUDE.md promising at-rest encryption.
//
// This module builds the same label-scoped AES-GCM crypto as the CF path,
// wrapped with a *legacy plaintext tolerance* on decrypt: rows written by
// pre-fix installs hold `JSON.stringify(auth)` verbatim (always starts with
// "{"), which can never collide with the base64url `iv||ciphertext` wire
// format WebCryptoAesGcm emits. Reads of those rows pass through unchanged
// instead of bricking every existing credential; any update re-encrypts
// (lazy migration). New writes are always encrypted.

import { WebCryptoAesGcm } from "@duyet/oma-integrations-adapters-node";
import type { Crypto } from "@duyet/oma-credentials-store";

/** Same derivation label the CF deployment uses (packages/services
 *  mintCrypto) so each subsystem gets a distinct AES key off the shared
 *  root secret. */
export const CREDENTIALS_CRYPTO_LABEL = "credentials.auth";

/** True when a stored `auth` value predates at-rest encryption on this
 *  install — the repo always stored `JSON.stringify(auth)`, so legacy rows
 *  start with "{", which is not a valid base64url character. */
export function isLegacyPlaintextAuth(stored: string): boolean {
  return stored.trimStart().startsWith("{");
}

/**
 * Build the credential-store crypto for the self-host Node runtime:
 * AES-256-GCM keyed off PLATFORM_ROOT_SECRET, decrypt-tolerant of legacy
 * plaintext rows written before this wiring existed.
 */
export function buildCredentialCrypto(platformRootSecret: string): Crypto {
  const inner = new WebCryptoAesGcm(platformRootSecret, CREDENTIALS_CRYPTO_LABEL);
  return {
    encrypt: (plaintext) => inner.encrypt(plaintext),
    async decrypt(stored) {
      if (isLegacyPlaintextAuth(stored)) return stored;
      return inner.decrypt(stored);
    },
  };
}
