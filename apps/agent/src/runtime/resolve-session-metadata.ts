// Resolve a session's metadata bag (publication_id / end_user_id / etc.) with
// a legacy fallback — issue #222.
//
// SessionDO mirrors session metadata into DO state at /init so notify-dispatch
// and turn-metering can read it synchronously instead of round-tripping to the
// session row on every access. Sessions created before that mirror existed
// never had the field written, so `cached` reads `undefined` for them forever
// (SessionDO state is DO-SQLite-persisted, not re-derived) — this module is
// the one-time fallback that reads the row instead, same path
// resolveMeteringWallet (issue #163) and assertSessionOwnedByPublication use.
//
// Extracted from session-do.ts so the fallback logic is unit-testable without
// a Durable Object — same rationale as notify-dispatch.ts / turn-metering.ts.

export interface ResolveSessionMetadataDeps {
  /** Row-level fallback lookup. Returns null when the session row is gone or
   *  carries no metadata. */
  lookupRow: (
    tenantId: string,
    sessionId: string,
  ) => Promise<Record<string, unknown> | null>;
}

/**
 * `cached` is `state.metadata`: `undefined` means this DO's state predates
 * the #222 mirror (never had the field written) — hit the row lookup once
 * and let the caller cache the result back into state. Any other value
 * (including `{}`) is authoritative and returned as-is, no row read.
 */
export async function resolveSessionMetadata(
  cached: Record<string, unknown> | undefined,
  tenantId: string,
  sessionId: string,
  deps: ResolveSessionMetadataDeps,
): Promise<Record<string, unknown>> {
  if (cached !== undefined) return cached;
  const row = await deps.lookupRow(tenantId, sessionId);
  return row ?? {};
}

/**
 * Derive the `per_1k_tokens` metering wallet identity (publication_id +
 * end_user_id) from a resolved metadata bag. Returns null for any session
 * that isn't a public consumer session (no publication_id / end_user_id) —
 * same rule resolveMeteringWallet (issue #163) used against the raw row.
 */
export function walletFromMetadata(
  meta: Record<string, unknown>,
): { publication_id: string; end_user_id: string } | null {
  const publicationId = meta.publication_id ? String(meta.publication_id) : "";
  const endUserId = meta.end_user_id ? String(meta.end_user_id) : "";
  return publicationId && endUserId
    ? { publication_id: publicationId, end_user_id: endUserId }
    : null;
}
