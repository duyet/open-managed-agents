// GitHubProvider configuration. Cleanly separated from runtime ports so the
// provider stays pure and testable.

import type { CapabilityKey } from "@duyet/oma-integrations-core";

export interface GitHubConfig {
  /**
   * Public origin of the integrations gateway, used to build the GitHub App
   * setup URL and webhook URL surfaced to the user. e.g.
   * "https://integrations.example.com". No trailing slash.
   */
  gatewayOrigin: string;

  /**
   * Default capability set for new publications. Per-publication overrides
   * (which may only further restrict) are stored on the Publication row.
   */
  defaultCapabilities: ReadonlyArray<CapabilityKey>;

  /**
   * GitHub MCP server URL the agent talks back through. Defaults to the
   * official GitHub Copilot-hosted MCP at https://api.githubcopilot.com/mcp/.
   * Override for self-hosted MCPs.
   */
  mcpServerUrl: string;

  /**
   * Public homepage URL embedded in manifests as the GitHub App's `url` field.
   * Shown on the App's GitHub-side page; informational only. Defaults to
   * `https://oma.duyet.net` if not overridden.
   */
  homepageUrl?: string;

  /**
   * OMA-hosted managed GitHub App credentials. When set, `startManagedInstall`
   * (the "Add to GitHub" one-click flow) is available: a publication shell is
   * created and immediately credentialed with this shared App's identity
   * (appId/appSlug/botLogin/privateKey/webhookSecret) — skipping the BYOA
   * manifest-creation step entirely. `clientId`/`clientSecret` are optional
   * since the managed flow doesn't require OAuth-as-user-auth for the
   * installation-token flow. When absent, `startManagedInstall` throws —
   * deployments without a managed App only get the manifest/BYOA wizard.
   *
   * IMPORTANT — webhook URL: this shared App has exactly ONE webhook URL
   * configured on github.com, regardless of how many publications install
   * it. Configure it as `<gateway-origin>/github/webhook/managed` (NOT the
   * per-App `/github/webhook/app/<appOmaId>` path BYOA Apps use — that path
   * is keyed on a per-publication id and only the publication whose id
   * happens to match would receive events). `handleManagedWebhook` resolves
   * the publication from the payload's `installation.id` instead.
   */
  managedApp?: {
    appId: string;
    appSlug: string;
    botLogin: string;
    privateKey: string;
    webhookSecret: string;
    clientId?: string | null;
    clientSecret?: string | null;
  } | null;
}

/**
 * Capabilities granted to a GitHub publication by default. Tilted toward
 * conservative writes — the publication owner can broaden via
 * `oma github update --caps …` if needed.
 *
 * Notably *excludes* destructive ops (`pr.merge`, `repo.branch.delete`,
 * `release.create`, `workflow.dispatch`, `issue.delete`, `comment.delete`)
 * which require explicit opt-in.
 */
export const DEFAULT_GITHUB_CAPABILITIES: ReadonlyArray<CapabilityKey> = [
  "issue.read",
  "issue.create",
  "issue.update",
  "comment.write",
  "label.add",
  "label.remove",
  "assignee.set",
  "status.set",
  "user.mention",
  "search.read",
  "pr.read",
  "pr.create",
  "pr.update",
  "pr.review.write",
  "pr.review.comment",
  "repo.read",
  "repo.write",
  "repo.branch.create",
  "workflow.read",
  "release.read",
] as const;

/** Full capability set including destructive ops — opt-in via `oma github update --caps`. */
export const ALL_GITHUB_CAPABILITIES: ReadonlyArray<CapabilityKey> = [
  ...DEFAULT_GITHUB_CAPABILITIES,
  "issue.delete",
  "comment.delete",
  "pr.merge",
  "pr.close",
  "repo.branch.delete",
  "workflow.dispatch",
  "release.create",
] as const;

/** Default GitHub-hosted MCP server URL. */
export const DEFAULT_GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/";
