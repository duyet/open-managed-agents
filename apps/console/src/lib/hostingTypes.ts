/**
 * Plain-language overrides for sandbox provider (hosting type) copy.
 * The backend (`/v1/hosting_types`) already returns a label + description,
 * but its wording is written for operators. This maps known wire ids to a
 * friendlier one-liner for non-technical users while still falling back to
 * whatever the backend sent for any id we don't recognize (custom BYOK
 * providers, future providers, etc.) — so nothing goes unlabeled.
 */
const FRIENDLY_DESCRIPTIONS: Record<string, string> = {
  cloud: "Cloudflare Sandbox — fully managed, no setup required.",
  subprocess: "Your own computer (subprocess) — no isolation, dev only.",
  e2b: "E2B — bring your own account, ephemeral cloud VMs.",
  modal: "Modal — bring your own account, isolated containers with optional GPUs.",
  daytona: "Daytona — bring your own account, cloud dev environments.",
  k8s: "Kubernetes — bring your own cluster, pod-per-sandbox.",
  kubernetes: "Kubernetes — bring your own cluster, pod-per-sandbox.",
};

export interface HostingTypeLike {
  id: string;
  label: string;
  description?: string;
  external?: boolean;
}

/** Friendly one-line description for a hosting type, falling back to the
 *  backend-provided description (or nothing) for unrecognized ids. */
export function friendlyHostingDescription(t: HostingTypeLike): string | undefined {
  return FRIENDLY_DESCRIPTIONS[t.id] ?? t.description;
}
