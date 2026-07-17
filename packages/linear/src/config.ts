// LinearProvider configuration. Cleanly separated from runtime ports so the
// provider remains pure and testable.

import type { CapabilityKey } from "@duyet/oma-integrations-core";

export interface LinearConfig {
  /**
   * Public origin of the integrations gateway, used to build OAuth callback
   * and webhook URLs surfaced to Linear. e.g. "https://integrations.example.com".
   */
  gatewayOrigin: string;

  /**
   * OAuth scopes requested at install time. Order doesn't matter; Linear
   * normalizes. Always includes `app:assignable` and `app:mentionable` so
   * the bot user can be assigned/mentioned in issues.
   */
  scopes: ReadonlyArray<string>;

  /**
   * Default capability set for new publications. Per-publication overrides
   * (which may only further restrict) are stored on the Publication row.
   */
  defaultCapabilities: ReadonlyArray<CapabilityKey>;

  /**
   * OMA-hosted managed Linear OAuth App credentials. When set,
   * `startManagedInstall` (the "Add to Linear" one-click flow) is available:
   * a publication shell is created and immediately credentialed with these
   * shared client_id/client_secret/webhook_secret, skipping the BYOA
   * "register your own OAuth app" step. When absent, `startManagedInstall`
   * throws — deployments without a managed App only get the OAuth/PAT
   * wizard.
   */
  managedApp?: {
    clientId: string;
    clientSecret: string;
    webhookSecret: string;
  } | null;
}

export const DEFAULT_LINEAR_SCOPES: ReadonlyArray<string> = [
  "read",
  "write",
  "app:assignable",
  "app:mentionable",
] as const;

export const ALL_CAPABILITIES: ReadonlyArray<CapabilityKey> = [
  "issue.read",
  "issue.create",
  "issue.update",
  "issue.delete",
  "comment.write",
  "comment.delete",
  "label.add",
  "label.remove",
  "assignee.set",
  "assignee.set_other",
  "status.set",
  "priority.set",
  "subissue.create",
  "user.mention",
  "search.read",
] as const;
