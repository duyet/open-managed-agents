// Unit coverage for the credential-store crypto wiring (issue #187) —
// AES-GCM round-trip, ciphertext opacity, and the legacy-plaintext decrypt
// tolerance that keeps pre-fix rows readable.

import { describe, it, expect } from "vitest";
import {
  buildCredentialCrypto,
  isLegacyPlaintextAuth,
} from "../src/lib/credential-crypto";

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

  it("isLegacyPlaintextAuth discriminates plaintext JSON from base64url", () => {
    expect(isLegacyPlaintextAuth('{"type":"static_bearer"}')).toBe(true);
    expect(isLegacyPlaintextAuth("  {\"a\":1}")).toBe(true);
    expect(isLegacyPlaintextAuth("aGVsbG8td29ybGQ")).toBe(false);
  });
});
