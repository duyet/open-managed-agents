/**
 * Historical secret values that shipped prefilled in `.env.example` before
 * the fix for github.com/duyet/oma issue #170. Any install that ran
 * `cp .env.example .env` without editing the secrets section ended up
 * sharing the exact same at-rest encryption key / session-signing key /
 * bootstrap API key as every other such install — and as this public repo.
 * Sharing PLATFORM_ROOT_SECRET means anyone can decrypt any install's
 * stored credentials; sharing BETTER_AUTH_SECRET means anyone can forge a
 * Console session cookie. Both are refuse-to-boot conditions, not warnings.
 *
 * Values are stored as SHA-256 digests rather than the plaintext so this
 * file doesn't re-plant the leaked literal in a fresh commit. See
 * `findLeakedPlaceholderSecrets` for the boot-time check that consumes it
 * (wired in apps/main-node/src/index.ts).
 *
 * Append new leaks here; never remove an entry — removing one re-opens the
 * hole for anyone whose checkout predates the fix.
 */
export const KNOWN_INSECURE_SECRET_SHA256: Readonly<Record<string, readonly string[]>> = {
  PLATFORM_ROOT_SECRET: ["c442b11d6aab58b94e0b4ec47dc83d2fc46b7e06afd7c740d5dae7d1a13f9773"],
  BETTER_AUTH_SECRET: ["107c58b00f714acecb588845d669aa2e02ac37672c4bdd8770d48838fb299f02"],
  API_KEY: ["4900188a9670761dae15a19a95b20b1024ddb904a0709b65deb2816fd3f46f55"],
  OMA_API_KEY: ["4900188a9670761dae15a19a95b20b1024ddb904a0709b65deb2816fd3f46f55"],
  INTEGRATIONS_INTERNAL_SECRET: ["0cf4e190e12945ee7bca4a714428a4e4e0ab643988363ff5d6a4d3b05b338976"],
  GITHUB_CLIENT_SECRET: ["4b62f1f86efcc7edf4a7137d4554984b41f041a70fdac1a003f9b7615c486e97"],
};

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Scans `env` for any variable listed in {@link KNOWN_INSECURE_SECRET_SHA256}
 * whose current value hashes to a historically-leaked digest. Returns the
 * offending variable names (empty when clean). Uses Web Crypto's
 * `crypto.subtle`, available identically on Cloudflare Workers and Node 20+.
 */
export async function findLeakedPlaceholderSecrets(
  env: Record<string, string | undefined>,
): Promise<string[]> {
  const hits: string[] = [];
  for (const [key, hashes] of Object.entries(KNOWN_INSECURE_SECRET_SHA256)) {
    const value = env[key];
    if (!value) continue;
    const digest = await sha256Hex(value);
    if (hashes.includes(digest)) hits.push(key);
  }
  return hits;
}

/**
 * Formats the fail-fast startup error message for the offending variable
 * names found by {@link findLeakedPlaceholderSecrets}.
 */
export function formatLeakedSecretError(offending: readonly string[]): string {
  return (
    `Refusing to start: ${offending.join(", ")} ${offending.length === 1 ? "is" : "are"} ` +
    `still set to a placeholder value that used to ship in .env.example ` +
    `(see github.com/duyet/oma issue #170). That value is public — every ` +
    `install that didn't change it shares the same key. Generate fresh ` +
    `secrets and set them before starting:\n` +
    `  openssl rand -hex 32       # BETTER_AUTH_SECRET\n` +
    `  openssl rand -base64 32    # PLATFORM_ROOT_SECRET / INTEGRATIONS_INTERNAL_SECRET`
  );
}
