#!/usr/bin/env node
/*
 * scripts/sync-secrets-prod.mjs
 *
 * Syncs a defined allowlist of secrets from the local, gitignored
 * `.env.local` up to:
 *   - the prod `main` Worker (app.oma.duyet.net) via `wrangler secret put`
 *   - GitHub Actions repo secrets via `gh secret set`   (opt-in, see --to)
 *
 * Why a Node helper instead of inline shell:
 *   - `.env.local` holds live secrets (PLATFORM_ROOT_SECRET, etc.) and must
 *     NEVER be printed, committed, or exposed. We read it here in-process and
 *     pipe each value straight into the target's stdin / stdin flag — the
 *     value is never echoed to stdout/stderr or stored in shell history.
 *   - Only allowlisted keys are pushed. Anything else in `.env.local` is
 *     ignored, so adding creds to the file doesn't accidentally leak
 *     unrelated secrets.
 *
 * Usage:
 *   node scripts/sync-secrets-prod.mjs                       # worker: all WORKER_SECRET_KEYS
 *   node scripts/sync-secrets-prod.mjs --to github          # github: all GITHUB_SECRET_KEYS
 *   node scripts/sync-secrets-prod.mjs --to worker,github   # both
 *   node scripts/sync-secrets-prod.mjs --to worker GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET
 *   node scripts/sync-secrets-prod.mjs --to worker --dry-run
 *
 * Prereqs:
 *   - `.env.local` in repo root
 *   - `npx wrangler` authenticated for the duyet.net account (worker target)
 *   - `gh` authenticated with `repo` scope for the target GitHub repo (github target)
 */

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CONFIG = "apps/main/wrangler.jsonc";
const ENV = "production";

// Secrets allowed to be pushed to the prod Worker. Add new keys as you onboard.
const WORKER_SECRET_KEYS = [
  "PLATFORM_ROOT_SECRET",
  "BETTER_AUTH_SECRET",
  "API_KEY",
  "INTEGRATIONS_INTERNAL_SECRET",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
];

// Secrets allowed to be pushed to GitHub Actions repo secrets. Keep this
// tight — anything here is readable by EVERY workflow.
//
// NOTE: GitHub forbids repo-secret names prefixed with `GITHUB_` (reserved
// namespace — `gh secret set` returns HTTP 422). The GitHub OAuth *app* creds
// (GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET) therefore CANNOT live here, and
// they shouldn't anyway: CI doesn't run `wrangler deploy`, and the agent
// image build doesn't need the OAuth app creds. Those are pushed to the
// Worker only (see WORKER_SECRET_KEYS). Add other cross-CI secrets here as
// needed (e.g. CLOUDFLARE_API_TOKEN for a future deploy workflow).
const GITHUB_SECRET_KEYS = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
];

// ── arg parse ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const toIdx = args.indexOf("--to");
const toArg = toIdx !== -1 ? args[toIdx + 1] : "worker";
const targets = String(toArg)
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

for (const t of targets) {
  if (t !== "worker" && t !== "github") {
    console.error(`✗ unknown --to target '${t}' (use 'worker' or 'github')`);
    process.exit(2);
  }
}

const explicitKeys = args.filter(
  (a) => a !== "--dry-run" && a !== "--to" && a !== toArg,
);

// ── parse .env.local ──────────────────────────────────────────────────────
let envText;
try {
  envText = readFileSync(resolve(ROOT, ".env.local"), "utf8");
} catch {
  console.error("✗ .env.local not found in repo root");
  process.exit(1);
}

/** Extract a value for `key` from .env text. Handles quotes + inline comments. */
function parseValue(text, key) {
  const re = new RegExp(`^[\\t ]*${key}[\\t ]*=([^\\n]*)$`, "m");
  const m = text.match(re);
  if (!m) return null;
  let v = m[1].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  v = v.replace(/[ \t]+#.*$/, ""); // strip trailing inline comment
  return v.length ? v : null;
}

// ── pushers ────────────────────────────────────────────────────────────
function pushToWorker(key, value) {
  console.log(`→ [worker] Putting secret ${key} …`);
  if (DRY_RUN) {
    console.log(`  (dry-run) would put ${key} [${value.length} chars] to ${CONFIG} --env ${ENV}`);
    return;
  }
  const res = spawnSync(
    "npx",
    ["wrangler", "secret", "put", key, "--config", CONFIG, `--env=${ENV}`],
    { input: value, stdio: ["pipe", "ignore", "inherit"] },
  );
  if (res.status !== 0) throw new Error(`wrangler secret put ${key} failed`);
  console.log(`✓ [worker] ${key} pushed to ${ENV}`);
}

function pushToGithub(key, value) {
  console.log(`→ [github] Setting repo secret ${key} …`);
  if (DRY_RUN) {
    console.log(`  (dry-run) would 'gh secret set ${key}' [${value.length} chars]`);
    return;
  }
  const res = spawnSync("gh", ["secret", "set", key], {
    input: value,
    stdio: ["pipe", "ignore", "inherit"],
  });
  if (res.status !== 0) throw new Error(`gh secret set ${key} failed`);
  console.log(`✓ [github] ${key} set as repo secret`);
}

// ── main ────────────────────────────────────────────────────────────────
let pushed = 0;
let skipped = 0;

for (const target of targets) {
  const allowlist = target === "worker" ? WORKER_SECRET_KEYS : GITHUB_SECRET_KEYS;
  const keys = explicitKeys.length > 0 ? explicitKeys : allowlist;

  console.log(`\n→ Target: ${target}`);
  for (const key of keys) {
    if (!allowlist.includes(key)) {
      console.error(
        `✗ '${key}' is not in the ${target} allowlist (scripts/sync-secrets-prod.mjs). Refusing to push unknown key.`,
      );
      process.exit(1);
    }
    // GitHub reserves the `GITHUB_` prefix for repo secrets — `gh secret set`
    // rejects it with HTTP 422. Block it loudly rather than failing mid-run.
    if (target === "github" && key.startsWith("GITHUB_")) {
      console.error(
        `✗ '${key}' starts with GITHUB_ — GitHub forbids repo-secret names with that prefix. Push it to the worker target instead.`,
      );
      process.exit(1);
    }
    const value = parseValue(envText, key);
    if (value == null) {
      console.warn(`! ${key} not found/empty in .env.local — skipping`);
      skipped++;
      continue;
    }
    try {
      target === "worker" ? pushToWorker(key, value) : pushToGithub(key, value);
      pushed++;
    } catch (e) {
      console.error(`✗ ${e.message}`);
      process.exit(1);
    }
  }
}

console.log(`\nDone. pushed=${pushed} skipped=${skipped}${DRY_RUN ? " (dry-run)" : ""}`);
if (!DRY_RUN && pushed > 0 && targets.includes("worker")) {
  console.log("A prod redeploy was triggered automatically by 'wrangler secret put'.");
}
