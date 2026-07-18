// Auto-clone: synthesize an in-memory github_repository resource from an
// environment's `config.git_repo` declaration, so it flows through the same
// mountResources → mountGitRepo path (resource-mounter.ts) as an explicit
// session repo resource. Extracted as a pure helper so the synthesis logic
// is unit-testable without a Durable Object — same rationale as
// notify-dispatch.ts / resolve-session-metadata.ts.

export interface EnvGitRepoConfig {
  url: string;
  branch?: string;
  credential_id?: string;
  mount_path?: string;
}

/**
 * Build the synthesized resource, or return null when there's nothing to
 * synthesize:
 *   - no `git_repo` configured on the environment
 *   - a session resource already targets the same mount path (avoids a
 *     double clone / clobbering an explicit repo resource the caller
 *     attached on purpose)
 *
 * Auth note: the returned resource is synthesized in-memory only — it is
 * never persisted as a session resource row, so the outbound proxy's
 * `resolveGithubCredentials` (apps/main/src/lib/github-creds.ts), which
 * reads *persisted* github_repository resources plus their per-resource
 * sessionSecrets token, never matches it. Cloning therefore runs
 * unauthenticated; private repos depend on the vault `cap_cli` gh-credential
 * fallback in the outbound proxy's catch-all resolver — exactly like
 * today's explicit repo resources, which also don't plumb `credential_id`
 * into mountGitRepo (resource-mounter.ts).
 */
export function synthesizeEnvRepoResource(
  gitRepo: EnvGitRepoConfig | undefined,
  existingResources: Array<Record<string, unknown>>,
): Record<string, unknown> | null {
  if (!gitRepo?.url) return null;

  const mountPath = gitRepo.mount_path || "/workspace";
  const alreadyMounted = existingResources.some((res) => {
    if (res.type !== "github_repository" && res.type !== "github_repo") return false;
    const resMountPath = (res.mount_path as string) || "/workspace";
    return resMountPath === mountPath;
  });
  if (alreadyMounted) return null;

  return {
    type: "github_repository",
    url: gitRepo.url,
    mount_path: mountPath,
    credential_id: gitRepo.credential_id,
    ...(gitRepo.branch ? { checkout: { type: "branch", name: gitRepo.branch } } : {}),
  };
}
