# Rotate: PLATFORM_ROOT_SECRET

Operator runbook for `scripts/rotate-platform-root-secret.ts`. Sibling of
`scripts/backfill-encrypt-secrets.ts` (which introduced encryption for these
columns in the first place) — this is the rotation path for changing the
secret value afterwards.

## What this does

Rewrites `credentials.auth` and `model_cards.api_key_cipher` in a tenant D1
shard from ciphertext-under-OLD-secret to ciphertext-under-NEW-secret,
row by row, with:

- **Idempotency**: every row is try-decrypted under NEW first; success means
  "already rotated" and the row is skipped. Safe to re-run after any
  interruption (crash, Ctrl-C, network blip) — no double-encryption risk.
- **Verify-before-commit**: OLD-decrypt → NEW-encrypt → NEW-decrypt the fresh
  ciphertext → assert it equals the original plaintext byte-for-byte.
  Nothing is written to the DB unless that check passes.
- **Dry-run**: `--dry-run` reports exactly what would change; zero writes.
- **No plaintext logging**: only row ids, counts, and error classes/messages
  ever hit stdout/stderr.
- **Fail-loud by default**: a row that doesn't decrypt under OLD or NEW
  aborts the whole run immediately (non-zero exit). Pass
  `--continue-on-error` to instead collect every such row and keep going —
  they are still never written, just batched into the report.
- **Atomic per-row swap**: each write is a CAS
  (`UPDATE ... WHERE id = ? AND col = ?<ciphertext-we-read>`), so a row
  changed by the live app between our read and write is detected and
  reported as a conflict (left untouched, picked up automatically on re-run)
  instead of being silently clobbered.

## Required env / secrets

| | |
|---|---|
| `CF_ACCOUNT_ID` | Cloudflare account UUID |
| `CF_API_TOKEN` | API token with `D1: Edit` on the shard you're rotating |
| `PLATFORM_ROOT_SECRET_OLD` | The secret currently in the worker (`wrangler secret list oma-agent` to confirm which one is live — the value itself isn't retrievable, use the value you have on record) |
| `PLATFORM_ROOT_SECRET_NEW` | The new secret you're rotating to |

**Back up `PLATFORM_ROOT_SECRET_OLD` before starting.** If a run is
interrupted partway and you lose the old secret, rows not yet rotated become
permanently unreadable — there's no way to derive OLD from NEW.

## Concurrency & downtime: read this before running

The runtime holds exactly **one** `PLATFORM_ROOT_SECRET` at a time — it
can't try both OLD and NEW on a read. That means there is an unavoidable
window during rotation where:

- Rows already rotated (NEW ciphertext) are readable only once the worker's
  live secret is NEW.
- Rows not yet rotated (still OLD ciphertext) are readable only while the
  worker's live secret is OLD.

**There is no way to make every row continuously readable throughout a
rotation without a maintenance window.** The accepted operational answer,
matching the original backfill script's cutover:

1. Flip the worker's `PLATFORM_ROOT_SECRET` wrangler secret to NEW and
   deploy. From this instant, reads of not-yet-rotated rows
   (`credentials.auth`, `model_cards.api_key_cipher`) fail with a decrypt
   error — the same class of brief outage the original backfill accepted.
2. Immediately run this script (non-dry-run) against every shard, in
   parallel, to close that window as fast as possible.
3. Once `wouldRotate=0` on every shard (see step 4), the outage is over.

This IS a live-writes-safe design in the sense that a credential written by
the app *during* the rotation window (under the runtime's current secret,
whichever that is) will either:
- be written under NEW (worker already flipped) → the rotation script's
  try-NEW-first check sees it as already rotated, skips it, done; or
- be written under OLD, then get raced against by this script's CAS write —
  the CAS guard makes this a detected "conflict" (reported, left alone,
  fixed by the next re-run) rather than data loss.

So: **short read-availability outage for not-yet-rotated rows is expected
and accepted**; **no data loss or corruption is possible** even under
concurrent writes, because of the CAS guard + verify-before-commit.

## Step-by-step cutover

### 0. Back up the old secret

Copy `PLATFORM_ROOT_SECRET_OLD` somewhere durable (secrets manager, sealed
note) before touching anything.

### 1. Dry-run on every shard (no impact, OLD secret still live)

```bash
for db in $(./scripts/list-shards.sh); do
  CF_ACCOUNT_ID=... CF_API_TOKEN=... \
  PLATFORM_ROOT_SECRET_OLD=... PLATFORM_ROOT_SECRET_NEW=... \
    pnpm tsx scripts/rotate-platform-root-secret.ts --db="$db" --dry-run
done
```

Confirm `failures=0` everywhere before proceeding — a nonzero failure count
here means the OLD secret you supplied doesn't match what's actually
encrypting those rows. Stop and reconcile before going further.

### 2. Flip the worker's secret to NEW

```bash
echo "$PLATFORM_ROOT_SECRET_NEW" | wrangler secret put PLATFORM_ROOT_SECRET --name <worker>
```

From this moment, reads of not-yet-rotated rows start failing. This is the
outage window step 3 closes.

### 3. Rotate every shard, in parallel

```bash
SHARDS=$(./scripts/list-shards.sh)
echo "$SHARDS" | xargs -P 8 -I {} \
  env CF_ACCOUNT_ID=... CF_API_TOKEN=... \
      PLATFORM_ROOT_SECRET_OLD=... PLATFORM_ROOT_SECRET_NEW=... \
    pnpm tsx scripts/rotate-platform-root-secret.ts --db={} --shard={}
```

### 4. Verify

```bash
for db in $(./scripts/list-shards.sh); do
  CF_ACCOUNT_ID=... CF_API_TOKEN=... \
  PLATFORM_ROOT_SECRET_OLD=... PLATFORM_ROOT_SECRET_NEW=... \
    pnpm tsx scripts/rotate-platform-root-secret.ts --db="$db" --dry-run
done
```

Every shard must show `wouldRotate=0` for both tables. Non-zero means
re-run step 3 for that shard (it's fully idempotent).

## Recovery from interruption

Just re-run step 3 for the affected shard. The try-NEW-first check means
already-rotated rows are instantly skipped; only remaining OLD-only rows are
touched. No manual bookkeeping needed.

## Known limitation / scope

This script rotates the same two columns `scripts/backfill-encrypt-secrets.ts`
introduced encryption for (`credentials.auth`, `model_cards.api_key_cipher`)
in the tenant control-plane D1. It does **not** yet cover the separate
`apps/integrations` D1 tables that also derive their AES key from
`PLATFORM_ROOT_SECRET` under the `"integrations.tokens"` label (GitHub/Slack/
Linear app installs — `client_secret_cipher`, `access_token_cipher`, etc. in
`packages/db-schema/src/cf-integrations/*` and the node-pg mirrors). Rotating
those requires a second invocation against the integrations D1 with a
different table/column list; the `rotateColumn()` helper this script exports
is deliberately table-agnostic so a follow-up can reuse it without
duplicating the decrypt/verify/CAS logic. Track that as a fast-follow before
actually rotating a production secret that also has integrations installed.

Self-host Postgres is not covered by this script's D1-over-HTTP transport
(same gap as `backfill-encrypt-secrets.ts`) — a Postgres variant would swap
the `d1Query` helper for a `pg` client using the same `rotateColumn()` logic.
