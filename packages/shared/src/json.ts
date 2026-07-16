// Small JSON parsing helpers shared across adapters and routes.
//
// Kept in @duyet/oma-shared so callers (apps/main deployments route,
// packages/scheduler deployment-runs store, …) import one canonical version
// instead of copying the same few lines. @duyet/oma-shared is a leaf package
// so importing it introduces no dependency cycle.

/**
 * Parse a JSON-encoded string array stored in a TEXT column (e.g. a
 * deployment's `vault_ids` / `memory_store_ids`). Returns `[]` for null,
 * non-JSON, or non-array values, and filters out any non-string members so
 * the result is always `string[]`.
 */
export function parseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
