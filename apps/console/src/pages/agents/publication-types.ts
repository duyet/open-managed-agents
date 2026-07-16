/** Publication wire shape — mirrors `toApi` in
 *  packages/http-routes/src/publications/index.ts (PublicationRow minus
 *  `tenant_id`). Returned by both `/v1/agents/:id/publications` and the
 *  tenant-wide `/v1/publications` (My Bots). */
export interface Publication {
  id: string;
  agent_id: string;
  agent_version: number;
  slug: string;
  title: string;
  description: string | null;
  avatar_url: string | null;
  visibility: "public" | "unlisted" | "private";
  status: "draft" | "live" | "paused";
  greeting: string | null;
  suggested_prompts: string[];
  pricing_ref: string | null;
  rate_limit_ref: string | null;
  /** Environment the public `/p/:slug/sessions` create binds to (issue
   *  #225). Null until set at publish time; a cloud agent published
   *  without one 409s on its first public message. */
  environment_id: string | null;
  created_at: string;
}

/** PUT /v1/publications/:id/pricing modes (apps/main/src/routes/payments.ts
 *  `publicationPricingInputSchema`). `subscription` is left out of the
 *  Console picker — it needs a Stripe price binding this dialog doesn't
 *  collect yet. */
export type PricingMode = "free" | "per_message" | "per_1k_tokens";
