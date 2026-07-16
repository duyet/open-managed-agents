// Public types for the publications store service.

/** Visibility governs who can reach a publication's public slug. */
export type PublicationVisibility = "public" | "unlisted" | "private";

/** Lifecycle state. Drives the anti-abuse floor before consumer auth (#2). */
export type PublicationStatus = "draft" | "live" | "paused";

/** Current-state publication row. JSON columns (suggested_prompts) are
 *  parsed in the adapter + surfaced as typed members here. */
export interface PublicationRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  agent_version: number;
  slug: string;
  title: string;
  description: string | null;
  avatar_url: string | null;
  visibility: PublicationVisibility;
  status: PublicationStatus;
  greeting: string | null;
  /** Parsed JSON array of suggested prompt strings (may be empty). */
  suggested_prompts: string[];
  /** FK reference into the pricing table (issue #3); null until wired. */
  pricing_ref: string | null;
  /** FK reference into the rate-limit table; null until wired. */
  rate_limit_ref: string | null;
  /** Environment the public session-create (POST /p/:slug/sessions) binds
   *  sessions to (issue #225). Null until set at publish time; required
   *  for a cloud agent to actually be able to chat. */
  environment_id: string | null;
  /** ISO-8601 timestamp. */
  created_at: string;
}
