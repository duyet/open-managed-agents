// Observability analytics routes.
//
//   GET /v1/analytics/overview        — tenant-wide session analytics
//   GET /v1/agents/:id/analytics      — per-agent (mounted in agents/index.ts)
//
// Both return the same {@link SessionAnalytics} shape, aggregated over a
// rolling range (`range` query param: 7d | 30d | 90d, default 30d), computed
// in JS from the control-plane sessions table (see SessionService.analytics).
//
// Error-rate definition + tool_usage/stop_reasons availability are documented
// on the SessionAnalytics type (@duyet/oma-sessions-store). In short: the
// control plane persists a per-session `stop_reason` and cumulative token /
// tool-call / message counters, but NOT per-tool-name breakdowns or an
// explicit error flag — so `tool_usage` is omitted (only `total_tool_calls` is
// available) and `error_rate` is derived from the `destroyed` stop reason.

import { Hono } from "hono";
import type { RouteServicesArg } from "../types";
import { resolveServices } from "../types";

interface Vars {
  Variables: { tenant_id: string; user_id?: string };
}

const ALLOWED_RANGES = ["7d", "30d", "90d"] as const;

/**
 * Validate the `range` query param. Absent → default "30d". A present-but-
 * unrecognized value is a 400 (not a silent fallback) so client bugs surface —
 * same strictness as the sessions-list `status` whitelist.
 */
export function parseAnalyticsRange(
  raw: string | undefined,
): { range: string } | { error: { code: string; message: string } } {
  if (raw === undefined || raw === "") return { range: "30d" };
  if ((ALLOWED_RANGES as readonly string[]).includes(raw)) return { range: raw };
  return {
    error: {
      code: "invalid_range",
      message: `Invalid range '${raw}'; expected one of ${ALLOWED_RANGES.join("|")}.`,
    },
  };
}

export interface AnalyticsRoutesDeps {
  services: RouteServicesArg;
}

export function buildAnalyticsRoutes(deps: AnalyticsRoutesDeps) {
  const app = new Hono<Vars>();

  // GET /v1/analytics/overview — tenant-wide session analytics.
  app.get("/overview", async (c) => {
    const services = resolveServices(deps.services, c);
    const parsed = parseAnalyticsRange(c.req.query("range"));
    if ("error" in parsed) {
      return c.json(
        { error: { type: "invalid_request_error", ...parsed.error } },
        400,
      );
    }
    const analytics = await services.sessions.analytics({
      tenantId: c.var.tenant_id,
      range: parsed.range,
    });
    return c.json(analytics);
  });

  return app;
}
