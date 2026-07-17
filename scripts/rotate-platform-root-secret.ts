#!/usr/bin/env tsx
/**
 * PLATFORM_ROOT_SECRET rotation: decrypt every AES-256-GCM row under the OLD
 * secret and re-encrypt it under the NEW secret, in place, in a single tenant
 * D1 shard.
 *
 * Why: `PLATFORM_ROOT_SECRET` has no rotation path today (see
 * `scripts/backfill-encrypt-secrets.ts` for the sibling one-shot that first
 * introduced encryption for these columns). Rotating the wrangler secret
 * without also rewriting existing ciphertext makes every row unreadable —
 * this script is the safe path to change the secret.
 *
 * Idempotent via try-decrypt-with-NEW-first: a row that already decrypts
 * under the NEW key is skipped (already rotated). Re-run is the recovery
 * path after a crash or Ctrl-C mid-run — no risk of double-encrypting.
 *
 * Verify-before-commit: for every row this script (1) decrypts under OLD,
 * (2) encrypts under NEW, (3) decrypts the fresh ciphertext under NEW and
 * asserts it equals the original plaintext byte-for-byte, and only THEN
 * writes it — with a CAS guard (`WHERE id = ? AND col = ?<old-ciphertext>`)
 * so a concurrent write to the same row during rotation is detected and
 * reported rather than clobbered.
 *
 * Fail-loud default: a row that fails to decrypt under BOTH the NEW and OLD
 * key aborts the whole run immediately (throws, non-zero exit, no further
 * rows are touched). Pass `--continue-on-error` to instead collect every
 * such row into the failure report and keep going — still never written,
 * just surfaced instead of halting. Default is abort-on-first because a row
 * undecryptable under the supplied OLD key almost always means the wrong
 * secret was passed, and continuing would burn through the rest of the
 * table under a bad assumption.
 *
 * NEVER logs plaintext. Only row ids, counts, byte lengths, and error
 * classes/messages are logged.
 *
 * Concurrency / downtime: see rotate-platform-root-secret.README.md. Short
 * version: this is NOT safe to run against a live runtime pointed at OLD —
 * the runtime must already be reading/writing with NEW before (or without
 * overlap after) this script runs, or newly-written rows under OLD would
 * need a second pass. The documented runbook uses a maintenance window: flip
 * the worker's secret to NEW, then run this script immediately after
 * (rotated rows become readable one at a time; not-yet-rotated rows return
 * decrypt errors from the runtime until this script reaches them — same
 * class of brief-read-failure window as the original backfill script).
 *
 * Usage:
 *   CF_ACCOUNT_ID=… CF_API_TOKEN=… \
 *   PLATFORM_ROOT_SECRET_OLD=… PLATFORM_ROOT_SECRET_NEW=… \
 *     pnpm tsx scripts/rotate-platform-root-secret.ts \
 *       --db=<d1-database-id> [--shard=<label>] [--dry-run] [--continue-on-error]
 *
 *   --db                 D1 database UUID for the tenant shard (required).
 *   --shard              Optional human-readable label used in log lines.
 *   --dry-run            Report counts; never write.
 *   --continue-on-error  Collect+report undecryptable rows instead of
 *                        aborting on the first one. Default: abort.
 *   --account            CF account UUID (or CF_ACCOUNT_ID env).
 *   --token              CF API token with D1:Edit (or CF_API_TOKEN env).
 *   --old-secret         Old root secret (or PLATFORM_ROOT_SECRET_OLD env).
 *   --new-secret         New root secret (or PLATFORM_ROOT_SECRET_NEW env).
 *   --page               Rows per page (default 200).
 */

import { WebCryptoAesGcm } from "../packages/integrations-adapters-cf/src/crypto";

interface CfApiResponse<T> {
  success: boolean;
  result: T;
  errors?: Array<{ code?: number; message: string }>;
}

async function cf<T>(
  accountId: string,
  token: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`,
    {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init?.headers as Record<string, string> | undefined),
      },
    },
  );
  const body = (await res.json()) as CfApiResponse<T>;
  if (!body.success) {
    throw new Error(
      `CF API ${res.status}: ${body.errors?.map((e) => e.message).join("; ") ?? "unknown"}`,
    );
  }
  return body.result;
}

async function d1Query<T = Record<string, unknown>>(
  accountId: string,
  token: string,
  databaseId: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const out = await cf<Array<{ results: T[] }>>(
    accountId,
    token,
    `/d1/database/${databaseId}/query`,
    { method: "POST", body: JSON.stringify({ sql, params }) },
  );
  return out[0]?.results ?? [];
}

/** Row-level outcome, kept plaintext-free. */
type RowOutcome =
  | { status: "already_rotated" }
  | { status: "would_rotate" }
  | { status: "rotated" }
  | { status: "conflict" } // CAS guard saw the row change under us
  | { status: "undecryptable"; reason: string };

export interface RotateColumnResult {
  table: string;
  scanned: number;
  alreadyRotated: number;
  rotated: number;
  wouldRotate: number;
  conflicts: number;
  failures: Array<{ id: string; reason: string }>;
}

export interface RotateColumnOpts {
  accountId: string;
  token: string;
  dbId: string;
  table: string;
  idColumn: string;
  cipherColumn: string;
  oldCrypto: WebCryptoAesGcm;
  newCrypto: WebCryptoAesGcm;
  pageSize: number;
  dryRun: boolean;
  continueOnError: boolean;
}

/** Decides + (if not dry-run) applies the outcome for a single row. Never logs plaintext. */
async function rotateRow(
  opts: RotateColumnOpts,
  row: { id: string; value: string },
): Promise<RowOutcome> {
  // 1. Idempotency check: already readable under NEW ⇒ already rotated (or
  //    never needed rotation). Skip — this is what makes re-runs safe.
  try {
    await opts.newCrypto.decrypt(row.value);
    return { status: "already_rotated" };
  } catch {
    // fall through — try OLD
  }

  // 2. Must decrypt cleanly under OLD, or this row is a hard failure.
  let plaintext: string;
  try {
    plaintext = await opts.oldCrypto.decrypt(row.value);
  } catch (err) {
    return {
      status: "undecryptable",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  if (opts.dryRun) {
    return { status: "would_rotate" };
  }

  // 3. Encrypt under NEW, then verify-before-commit: decrypt what we just
  //    produced and diff it against the original plaintext byte-for-byte.
  const newCiphertext = await opts.newCrypto.encrypt(plaintext);
  const roundTrip = await opts.newCrypto.decrypt(newCiphertext);
  if (roundTrip !== plaintext) {
    // Never persisted. Report as a failure, not a silent skip.
    return {
      status: "undecryptable",
      reason: "round-trip verification mismatch after re-encryption",
    };
  }

  // 4. Atomic swap with a CAS guard: only write if the row still holds the
  //    exact ciphertext we read. A concurrent write during our window (e.g.
  //    a live credential rotation by the app itself) makes this a no-op we
  //    can detect and report, instead of silently clobbering fresher data.
  await d1Query(
    opts.accountId,
    opts.token,
    opts.dbId,
    `UPDATE ${opts.table} SET ${opts.cipherColumn} = ? WHERE ${opts.idColumn} = ? AND ${opts.cipherColumn} = ?`,
    [newCiphertext, row.id, row.value],
  );
  // D1's HTTP API doesn't surface an affected-row count on this path, so we
  // re-select to confirm the write actually landed as ours (vs. a concurrent
  // writer having changed the row again between our UPDATE and now).
  const verify = await d1Query<{ value: string }>(
    opts.accountId,
    opts.token,
    opts.dbId,
    `SELECT ${opts.cipherColumn} AS value FROM ${opts.table} WHERE ${opts.idColumn} = ?`,
    [row.id],
  );
  if (verify[0]?.value !== newCiphertext) {
    return { status: "conflict" };
  }

  return { status: "rotated" };
}

export async function rotateColumn(
  opts: RotateColumnOpts,
): Promise<RotateColumnResult> {
  const result: RotateColumnResult = {
    table: `${opts.table}.${opts.cipherColumn}`,
    scanned: 0,
    alreadyRotated: 0,
    rotated: 0,
    wouldRotate: 0,
    conflicts: 0,
    failures: [],
  };

  let lastId: string | null = null;
  while (true) {
    // Keyset-paginate by primary key — resumable: a fresh invocation with no
    // in-memory state just starts from the beginning and re-derives the same
    // "already rotated" skip decisions from the try-decrypt check above.
    const sql =
      lastId === null
        ? `SELECT ${opts.idColumn} AS id, ${opts.cipherColumn} AS value
           FROM ${opts.table}
           ORDER BY ${opts.idColumn}
           LIMIT ?`
        : `SELECT ${opts.idColumn} AS id, ${opts.cipherColumn} AS value
           FROM ${opts.table}
           WHERE ${opts.idColumn} > ?
           ORDER BY ${opts.idColumn}
           LIMIT ?`;
    const params = lastId === null ? [opts.pageSize] : [lastId, opts.pageSize];

    const rows = await d1Query<{ id: string; value: string }>(
      opts.accountId,
      opts.token,
      opts.dbId,
      sql,
      params,
    );
    if (rows.length === 0) break;

    result.scanned += rows.length;

    for (const row of rows) {
      const outcome = await rotateRow(opts, row);
      switch (outcome.status) {
        case "already_rotated":
          result.alreadyRotated += 1;
          break;
        case "would_rotate":
          result.wouldRotate += 1;
          break;
        case "rotated":
          result.rotated += 1;
          break;
        case "conflict":
          result.conflicts += 1;
          console.error(
            `  [${opts.table}.${opts.cipherColumn}] CONFLICT id=${row.id}: ` +
              `row changed concurrently during rotation, left untouched (will retry next run)`,
          );
          break;
        case "undecryptable":
          result.failures.push({ id: row.id, reason: outcome.reason });
          if (!opts.continueOnError) {
            console.error(
              `\n✗ Row ${opts.table}.${row.id} failed to decrypt under either key. ` +
                `Aborting run (default fail-loud behavior — pass --continue-on-error to collect all failures instead).`,
            );
            return result;
          }
          break;
      }
    }

    console.log(
      `  [${opts.table}.${opts.cipherColumn}] scanned ${result.scanned}, ` +
        `alreadyRotated ${result.alreadyRotated}, rotated ${result.rotated}, ` +
        `wouldRotate ${result.wouldRotate}, conflicts ${result.conflicts}, ` +
        `failures ${result.failures.length}`,
    );

    if (!opts.continueOnError && result.failures.length > 0) break;

    lastId = rows[rows.length - 1]!.id;
    if (rows.length < opts.pageSize) break;
  }

  return result;
}

function parseArgs(): Record<string, string> {
  return Object.fromEntries(
    process.argv
      .slice(2)
      .filter((a) => a.startsWith("--"))
      .map((a) => {
        const [k, v] = a.slice(2).split("=");
        return [k!, v ?? "true"];
      }),
  );
}

async function main(): Promise<void> {
  const args = parseArgs();
  const accountId = args.account ?? process.env.CF_ACCOUNT_ID;
  const token = args.token ?? process.env.CF_API_TOKEN;
  const dbId = args.db;
  const shard = args.shard ?? dbId;
  const oldSecret = args["old-secret"] ?? process.env.PLATFORM_ROOT_SECRET_OLD;
  const newSecret = args["new-secret"] ?? process.env.PLATFORM_ROOT_SECRET_NEW;
  const pageSize = parseInt(args.page ?? "200", 10);
  const dryRun = args["dry-run"] === "true";
  const continueOnError = args["continue-on-error"] === "true";

  if (!accountId || !token || !dbId || !oldSecret || !newSecret) {
    console.error(
      "Usage: pnpm tsx scripts/rotate-platform-root-secret.ts \\\n" +
        "  --db=<d1-database-id> [--shard=<label>] [--dry-run] [--continue-on-error]\n" +
        "Required env (or flags): CF_ACCOUNT_ID, CF_API_TOKEN, PLATFORM_ROOT_SECRET_OLD, PLATFORM_ROOT_SECRET_NEW",
    );
    process.exit(1);
  }

  if (oldSecret === newSecret) {
    console.error("✗ PLATFORM_ROOT_SECRET_OLD and _NEW are identical — nothing to rotate.");
    process.exit(1);
  }

  console.log(
    `[shard=${shard}] dbId=${dbId} dryRun=${dryRun} continueOnError=${continueOnError} pageSize=${pageSize}`,
  );

  // Same labels as buildServices()'s mintCrypto() (packages/services) so the
  // derived AES key for each column matches the runtime exactly.
  const columns: Array<{ table: string; idColumn: string; cipherColumn: string; label: string }> = [
    { table: "credentials", idColumn: "id", cipherColumn: "auth", label: "credentials.auth" },
    { table: "model_cards", idColumn: "id", cipherColumn: "api_key_cipher", label: "model.cards.keys" },
  ];

  const results: RotateColumnResult[] = [];
  for (const col of columns) {
    console.log(`\n=== ${col.table}.${col.cipherColumn} ===`);
    const oldCrypto = new WebCryptoAesGcm(oldSecret, col.label);
    const newCrypto = new WebCryptoAesGcm(newSecret, col.label);
    const result = await rotateColumn({
      accountId,
      token,
      dbId,
      table: col.table,
      idColumn: col.idColumn,
      cipherColumn: col.cipherColumn,
      oldCrypto,
      newCrypto,
      pageSize,
      dryRun,
      continueOnError,
    });
    results.push(result);
    if (!continueOnError && result.failures.length > 0) {
      console.error(`\n✗ Aborted on first undecryptable row in ${result.table}. No further tables processed.`);
      process.exit(2);
    }
  }

  console.log(`\n=== Summary [shard=${shard}] ===`);
  let totalFailures = 0;
  let totalConflicts = 0;
  for (const r of results) {
    totalFailures += r.failures.length;
    totalConflicts += r.conflicts;
    console.log(
      `  ${r.table}: scanned=${r.scanned}, alreadyRotated=${r.alreadyRotated}, ` +
        `rotated=${r.rotated}, wouldRotate=${r.wouldRotate}, conflicts=${r.conflicts}, ` +
        `failures=${r.failures.length}`,
    );
    if (r.failures.length > 0) {
      console.log(`    First 5 failures:`);
      for (const f of r.failures.slice(0, 5)) {
        console.log(`      ${f.id}: ${f.reason}`);
      }
    }
  }

  if (totalFailures > 0) {
    console.error(`\n✗ ${totalFailures} rows failed to decrypt under either key. Investigate before re-running.`);
    process.exit(2);
  }

  if (totalConflicts > 0) {
    console.error(
      `\n⚠ ${totalConflicts} row(s) changed concurrently and were left untouched. Re-run to pick them up.`,
    );
    process.exit(2);
  }

  if (dryRun) {
    console.log(`\n✓ Dry run complete. No writes performed. Re-run without --dry-run to apply.`);
  } else {
    const remaining = results.reduce((sum, r) => sum + r.wouldRotate, 0);
    console.log(
      remaining === 0
        ? `\n✓ Rotation complete. Verify by re-running with --dry-run; wouldRotate must be 0 for every table.`
        : `\n✗ ${remaining} rows still need rotation. Re-run.`,
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
