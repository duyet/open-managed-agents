// Unit coverage for the shared credentials.auth crypto (issue #187) —
// AES-GCM round-trip, ciphertext opacity, the legacy-plaintext decrypt
// tolerance that keeps pre-fix rows readable, and byte-format interop with
// the WebCryptoAesGcm class the CF deployment's mintCrypto uses.

import { describe, it, expect } from "vitest";
import {
  buildCredentialCrypto,
  isLegacyPlaintextAuth,
  CREDENTIALS_CRYPTO_LABEL,
} from "@duyet/oma-shared";
import { WebCryptoAesGcm } from "@duyet/oma-integrations-adapters-node";

const SECRET = "unit-test-root-secret";

describe("buildCredentialCrypto", () => {
  it("encrypt → decrypt round-trips and ciphertext hides the plaintext", async () => {
    const crypto = buildCredentialCrypto(SECRET);
    const plaintext = JSON.stringify({ type: "static_bearer", token: "ghp_secret" });
    const cipher = await crypto.encrypt(plaintext);
    expect(cipher).not.toContain("ghp_secret");
    expect(cipher.startsWith("{")).toBe(false);
    await expect(crypto.decrypt(cipher)).resolves.toBe(plaintext);
  });

  it("decrypt passes legacy plaintext JSON rows through unchanged", async () => {
    const crypto = buildCredentialCrypto(SECRET);
    const legacy = JSON.stringify({ type: "static_bearer", token: "legacy" });
    await expect(crypto.decrypt(legacy)).resolves.toBe(legacy);
  });

  it("decrypt still fails loudly on garbage that is neither format", async () => {
    const crypto = buildCredentialCrypto(SECRET);
    await expect(crypto.decrypt("not-base64url-and-not-json")).rejects.toThrow();
  });

  it("a different root secret cannot decrypt", async () => {
    const a = buildCredentialCrypto(SECRET);
    const b = buildCredentialCrypto("some-other-secret");
    const cipher = await a.encrypt('{"type":"static_bearer"}');
    await expect(b.decrypt(cipher)).rejects.toThrow();
  });

  it("refuses an empty secret", () => {
    expect(() => buildCredentialCrypto("")).toThrow(/non-empty/);
  });

  it("isLegacyPlaintextAuth discriminates plaintext JSON from base64url", () => {
    expect(isLegacyPlaintextAuth('{"type":"static_bearer"}')).toBe(true);
    expect(isLegacyPlaintextAuth('  {"a":1}')).toBe(true);
    expect(isLegacyPlaintextAuth("aGVsbG8td29ybGQ")).toBe(false);
  });

  // Byte-format interop pin: the CF deployment encrypts this column with
  // WebCryptoAesGcm(secret, "credentials.auth") (packages/services
  // mintCrypto). The shared helper MUST stay wire-compatible so a database
  // migrated between deployments (or the oma-vault sidecar reading rows
  // written by either) keeps decrypting. If this test breaks, one side's
  // key derivation or framing drifted — that is a data-loss bug, not a
  // test to update.
  it("is wire-compatible with WebCryptoAesGcm(secret, 'credentials.auth')", async () => {
    const shared = buildCredentialCrypto(SECRET);
    const reference = new WebCryptoAesGcm(SECRET, CREDENTIALS_CRYPTO_LABEL);
    const plaintext = '{"type":"static_bearer","token":"interop"}';

    const fromReference = await reference.encrypt(plaintext);
    await expect(shared.decrypt(fromReference)).resolves.toBe(plaintext);

    const fromShared = await shared.encrypt(plaintext);
    await expect(reference.decrypt(fromShared)).resolves.toBe(plaintext);
  });
});
