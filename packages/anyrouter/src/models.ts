// AnyRouter model catalog — GET /api/v1/models. Structured JSON, requires
// the connected sk-ar-… key as bearer. This supersedes parsing the
// human-oriented https://anyrouter.dev/llms.txt docs index: /api/v1/models
// is the actual machine-readable catalog (pricing, context limits,
// capabilities) llms.txt just links out to.

import { ANYROUTER_MODELS_URL } from "./config";
import type { HttpRequestSpec } from "./oauth";

export function buildModelsRequest(apiKey: string): HttpRequestSpec {
  return {
    method: "GET",
    url: ANYROUTER_MODELS_URL,
    headers: { authorization: `Bearer ${apiKey}` },
    body: "",
  };
}

/** One row of AnyRouter's model catalog. Loosely typed — the upstream shape
 *  is richer (pricing, context limits, capability flags); callers that need
 *  more should read `raw`. */
export interface AnyRouterModel {
  id: string;
  name?: string;
  raw: Record<string, unknown>;
}

export function parseModelsResponse(body: string): AnyRouterModel[] {
  const parsed = JSON.parse(body) as { data?: unknown[] } | unknown[];
  const rows = Array.isArray(parsed) ? parsed : (parsed.data ?? []);
  const models: AnyRouterModel[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id : undefined;
    if (!id) continue;
    models.push({
      id,
      name: typeof r.name === "string" ? r.name : undefined,
      raw: r,
    });
  }
  return models;
}

/** One of the account's saved presets. AnyRouter's authenticated GET
 *  /api/v1/models response carries a top-level `presets` array alongside
 *  `data`. Loosely typed — the upstream shape is richer; callers that need
 *  more should read `raw`. */
export interface AnyRouterPreset {
  id: string;
  slug?: string;
  name?: string;
  description?: string;
  config?: Record<string, unknown>;
  raw: Record<string, unknown>;
}

/** Extract the account's saved presets from an authenticated GET
 *  /api/v1/models response. Tolerates absence (unauthenticated responses,
 *  or accounts with no presets) by returning `[]`. */
export function parsePresetsResponse(body: string): AnyRouterPreset[] {
  const parsed = JSON.parse(body) as { presets?: unknown };
  const rows = Array.isArray(parsed?.presets) ? parsed.presets : [];
  const presets: AnyRouterPreset[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id : undefined;
    if (!id) continue;
    presets.push({
      id,
      slug: typeof r.slug === "string" ? r.slug : undefined,
      name: typeof r.name === "string" ? r.name : undefined,
      description: typeof r.description === "string" ? r.description : undefined,
      config: r.config && typeof r.config === "object" ? (r.config as Record<string, unknown>) : undefined,
      raw: r,
    });
  }
  return presets;
}
