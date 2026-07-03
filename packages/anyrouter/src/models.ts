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
