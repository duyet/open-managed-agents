// Environment-level env-var storage reconciliation.
//
// Persistent env vars defined on an Environment record are reused by every
// session created with that environment. This module owns the security-
// sensitive half of that feature: deciding what lands in the plain D1 record
// vs. the KV secret store.
//
// Rules (mirrors the session `env` resource precedent — values NEVER live in
// the plain record when marked sensitive):
//   - non-sensitive var → `{ name, value }` stored inline in config.env_vars.
//   - sensitive var     → value written to KV `secret:env:{envId}:{name}`;
//     config keeps only `{ name, sensitive: true, has_value }`.
//
// `reconcileEnvVars` takes the caller-supplied desired list plus the currently
// stored list, performs the KV writes/deletes needed to reach the desired
// state, and returns the sanitized array to persist in the environment record.

import type { EnvVarSpec } from "@duyet/oma-shared";
import type { KvStore } from "@duyet/oma-kv-store";

const NAME_MAX = 256;
const VALUE_MAX = 32_768;
const ENV_VARS_MAX = 200;
// POSIX-ish env var name: letters, digits, underscore; must not start with a
// digit. Rejecting `=` and whitespace keeps a pasted `.env` line from smuggling
// a bad key into the sandbox.
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type ValidationResult = { ok: true } | { ok: false; error: string };

/** Validate a caller-supplied env_vars array (create/update). */
export function validateEnvVars(vars: unknown): ValidationResult {
  if (vars === undefined || vars === null) return { ok: true };
  if (!Array.isArray(vars)) return { ok: false, error: "config.env_vars must be an array" };
  if (vars.length > ENV_VARS_MAX) {
    return { ok: false, error: `config.env_vars has ${vars.length} entries; max ${ENV_VARS_MAX}` };
  }
  const seen = new Set<string>();
  for (const raw of vars) {
    if (typeof raw !== "object" || raw === null) {
      return { ok: false, error: "config.env_vars entries must be objects" };
    }
    const v = raw as Record<string, unknown>;
    const name = v.name;
    if (typeof name !== "string" || !NAME_RE.test(name) || name.length > NAME_MAX) {
      return {
        ok: false,
        error: `config.env_vars: invalid name ${JSON.stringify(name)} (must match ${NAME_RE.source})`,
      };
    }
    if (seen.has(name)) {
      return { ok: false, error: `config.env_vars: duplicate name ${JSON.stringify(name)}` };
    }
    seen.add(name);
    if (v.value !== undefined && typeof v.value !== "string") {
      return { ok: false, error: `config.env_vars.${name}.value must be a string` };
    }
    if (typeof v.value === "string" && v.value.length > VALUE_MAX) {
      return {
        ok: false,
        error: `config.env_vars.${name}.value length ${v.value.length} exceeds ${VALUE_MAX}`,
      };
    }
    if (v.sensitive !== undefined && typeof v.sensitive !== "boolean") {
      return { ok: false, error: `config.env_vars.${name}.sensitive must be a boolean` };
    }
  }
  return { ok: true };
}

/** KV key holding a sensitive environment-level env var's value. */
export function envSecretKey(tenantId: string, environmentId: string, name: string): string {
  return `t:${tenantId}:secret:env:${environmentId}:${name}`;
}

/**
 * Reconcile the desired env_vars against what's currently stored, writing /
 * deleting KV secrets as needed, and return the sanitized array to persist in
 * the environment record's config. Replace semantics: `incoming` is the full
 * desired set; any previously-stored sensitive secret whose name is dropped
 * (or flips to non-sensitive) has its KV key deleted.
 *
 * Sensitive vars supplied WITHOUT a value preserve the existing secret (the
 * Console omits the value when the user didn't retype it), carrying forward
 * the prior `has_value`.
 */
export async function reconcileEnvVars(
  kv: KvStore,
  tenantId: string,
  environmentId: string,
  incoming: EnvVarSpec[] | undefined,
  existing: EnvVarSpec[] | undefined,
): Promise<EnvVarSpec[]> {
  const desired = incoming ?? [];
  const prior = existing ?? [];
  const priorSensitive = new Map<string, EnvVarSpec>();
  for (const v of prior) {
    if (v.sensitive) priorSensitive.set(v.name, v);
  }

  const stored: EnvVarSpec[] = [];
  const keptSensitiveNames = new Set<string>();

  for (const v of desired) {
    if (v.sensitive) {
      if (typeof v.value === "string" && v.value.length > 0) {
        // New / rotated secret → write to KV, drop from the plain record.
        await kv.put(envSecretKey(tenantId, environmentId, v.name), v.value);
        stored.push({ name: v.name, sensitive: true, has_value: true });
      } else {
        // No value supplied → preserve whatever secret already exists.
        const had = priorSensitive.get(v.name)?.has_value ?? false;
        stored.push({ name: v.name, sensitive: true, has_value: had });
      }
      keptSensitiveNames.add(v.name);
    } else {
      // Non-sensitive → value rides inline; drop any stale secret for this name.
      if (priorSensitive.has(v.name)) {
        await kv.delete(envSecretKey(tenantId, environmentId, v.name));
      }
      stored.push({ name: v.name, value: v.value ?? "" });
    }
  }

  // Purge secrets for sensitive names that were removed entirely.
  for (const name of priorSensitive.keys()) {
    if (!keptSensitiveNames.has(name)) {
      await kv.delete(envSecretKey(tenantId, environmentId, name));
    }
  }

  return stored;
}

/** Best-effort deletion of every env secret for an environment (on env delete). */
export async function deleteAllEnvSecrets(
  kv: KvStore,
  tenantId: string,
  environmentId: string,
  vars: EnvVarSpec[] | undefined,
): Promise<void> {
  for (const v of vars ?? []) {
    if (v.sensitive) {
      await kv.delete(envSecretKey(tenantId, environmentId, v.name));
    }
  }
}
