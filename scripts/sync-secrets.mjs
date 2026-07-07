#!/usr/bin/env node
/**
 * scripts/sync-secrets.mjs
 *
 * One-stop sync: read `.env.local`, push each allowlisted secret to its
 * target — the three prod CF Workers OR GitHub Actions repo secrets.
 *
 * Why a Node helper instead of shell:
 *   - `.env.local` holds live secrets and must NEVER be printed, committed,
 *     or exposed. We read it in-process and pipe each value straight into
 *     the target's stdin — the value is never echoed to stdout/stderr or
 *     stored in shell history.
 *   - Only allowlisted keys per target are pushed. Anything else in
 *     `.env.local` is ignored.
 *
 * Usage:
 *   node scripts/sync-secrets.mjs                           # all targets
 *   node scripts/sync-secrets.mjs --to main                 # main worker only
 *   node scripts/sync-secrets.mjs --to agent                # agent/sandbox worker only
 *   node scripts/sync-secrets.mjs --to integrations         # integrations worker only
 *   node scripts/sync-secrets.mjs --to github               # GitHub Actions secrets only
 *   node scripts/sync-secrets.mjs --to main,github          # composite targets
 *   node scripts/sync-secrets.mjs --to main PLATFORM_ROOT_SECRET  # single key
 *   node scripts/sync-secrets.mjs --dry-run                 # preview only
 *
 * Prereqs:
 *   - `.env.local` in repo root
 *   - `npx wrangler` authenticated for the duyet.net account (worker targets)
 *   - `gh` authenticated with `repo` scope (github target)
 */

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ─── TARGET DEFINITIONS ──────────────────────────────────────────────────
//
// Each worker target declares what secrets it needs and how to push them.
// The allowlist prevents accidental leakage — unknown keys are rejected.

const TARGETS = {
  main: {
    label: "oma-managed-agents (main API + Console)",
    workerName: "oma-managed-agents",
    config: "apps/main/wrangler.jsonc",
    env: "production",
    allowlist: [
      // Required — all three are mandatory for the platform to boot
      "PLATFORM_ROOT_SECRET",   // AES-GCM encryption key (credentials, model cards, vaults)
      "BETTER_AUTH_SECRET",     // better-auth session signing
      "BETTER_AUTH_URL",        // public origin for social OAuth redirects
      "API_KEY",                // bootstrap REST API key
      "INTEGRATIONS_INTERNAL_SECRET",  // shared secret for /v1/internal/* gating
      // OAuth providers (optional — only if GitHub login is wired)
      "GITHUB_CLIENT_ID",
      "GITHUB_CLIENT_SECRET",
      // Future OAuth providers
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
    ],
  },

  agent: {
    label: "oma-sandbox-default (agent / sandbox / harness)",
    workerName: "oma-sandbox-default",
    allowlist: [
      // Required — without this, buildServices fails and sessions can't start
      "PLATFORM_ROOT_SECRET",   // decrypts vault creds + model card keys during sandbox warmup
      // LLM credentials (optional — fallback when tenant has no Model Card)
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_MODEL",
      "ANYROUTER_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      // Tunables
      "OMA_MAX_OUTPUT_TOKENS",
    ],
  },

  integrations: {
    label: "oma-managed-agents-integrations (webhook / OAuth gateway)",
    workerName: "oma-managed-agents-integrations",
    allowlist: [
      // Required
      "PLATFORM_ROOT_SECRET",   // decrypts OAuth tokens for Linear / GitHub / Slack
      "INTEGRATIONS_INTERNAL_SECRET",  // shared secret with main for /v1/internal/* RPC
      // OAuth (needed for GitHub App manifest flow callbacks)
      "GITHUB_CLIENT_ID",
      "GITHUB_CLIENT_SECRET",
    ],
  },

  github: {
    label: "GitHub Actions repo secrets",
    allowlist: [
      "CLOUDFLARE_API_TOKEN",   // for wrangler deploy in CI
      "CLOUDFLARE_ACCOUNT_ID",  // CF account for deploy CI
    ],
  },
};

const TARGET_NAMES = Object.keys(TARGETS);

// ─── CLI ARGS ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const toIdx = args.indexOf("--to");
const toArg = toIdx !== -1 ? args[toIdx + 1] : TARGET_NAMES.join(",");
const selectedTargets = String(toArg)
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

for (const t of selectedTargets) {
  if (!TARGET_NAMES.includes(t)) {
    console.error(
      `✗ unknown --to target '${t}' — choose from: ${TARGET_NAMES.join(", ")}`,
    );
    process.exit(2);
  }
}

// Optional explicit keys (defaults to the allowlist of each target)
const explicitKeys = args.filter(
  (a) => a !== "--dry-run" && a !== "--to" && a !== toArg,
);

// ─── PARSE .env.local ────────────────────────────────────────────────────
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

// ─── PUSHERS ─────────────────────────────────────────────────────────────
function pushToWorker(targetDef, key, value) {
  const { workerName } = targetDef;
  console.log(`  → [${workerName}] Putting secret ${key} …`);
  if (DRY_RUN) {
    console.log(`    (dry-run) would put ${key} [${value.length} chars]`);
    return;
  }
  const res = spawnSync(
    "npx",
    ["wrangler", "secret", "put", key, "--name", workerName],
    { input: value, stdio: ["pipe", "ignore", "inherit"] },
  );
  if (res.status !== 0) throw new Error(`wrangler secret put ${key} failed on ${workerName}`);
  console.log(`    ✓ ${key} pushed to ${workerName}`);
}

function pushToGithub(key, value) {
  console.log(`  → [github] Setting repo secret ${key} …`);
  if (DRY_RUN) {
    console.log(`    (dry-run) would 'gh secret set ${key}' [${value.length} chars]`);
    return;
  }
  const res = spawnSync("gh", ["secret", "set", key], {
    input: value,
    stdio: ["pipe", "ignore", "inherit"],
  });
  if (res.status !== 0) throw new Error(`gh secret set ${key} failed`);
  console.log(`    ✓ ${key} set as GitHub repo secret`);
}

// ─── MAIN ────────────────────────────────────────────────────────────────
let totalPushed = 0;
let totalSkipped = 0;

for (const targetName of selectedTargets) {
  const targetDef = TARGETS[targetName];
  const label = targetDef.label;
  const allowlist = targetDef.allowlist;
  const keys = explicitKeys.length > 0 ? explicitKeys : allowlist;

  console.log(`\n── ${targetName} — ${label} ──`);

  for (const key of keys) {
    // Allowlist enforcement
    if (!allowlist.includes(key)) {
      console.error(
        `  ✗ '${key}' is not in the ${targetName} allowlist (scripts/sync-secrets.mjs). Refusing to push unknown key.`,
      );
      process.exit(1);
    }
    // GitHub forbids GITHUB_ prefix on repo secret names
    if (targetName === "github" && key.startsWith("GITHUB_")) {
      console.error(
        `  ✗ '${key}' starts with GITHUB_ — GitHub forbids repo-secret names with that prefix. Push to a worker target instead.`,
      );
      process.exit(1);
    }
    const value = parseValue(envText, key);
    if (value == null) {
      console.warn(`  ! ${key} not found/empty in .env.local — skipping`);
      totalSkipped++;
      continue;
    }
    try {
      if (targetName === "github") {
        pushToGithub(key, value);
      } else {
        pushToWorker(targetDef, key, value);
      }
      totalPushed++;
    } catch (e) {
      console.error(`  ✗ ${e.message}`);
      process.exit(1);
    }
  }
}

console.log(
  `\nDone. pushed=${totalPushed} skipped=${totalSkipped}${DRY_RUN ? " (dry-run)" : ""}`,
);
if (!DRY_RUN && totalPushed > 0) {
  const hasWorkerTarget = selectedTargets.some((t) => t !== "github");
  if (hasWorkerTarget) {
    console.log(
      "Note: 'wrangler secret put' triggers an automatic redeploy for each updated worker.",
    );
  }
}
