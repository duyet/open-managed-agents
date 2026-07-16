import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { TriangleAlertIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ApiError } from "../lib/api";
import { formatQueryError, useApiQuery } from "../lib/useApiQuery";
import { EmptyState } from "../components/EmptyState";
import { Skeleton, SkeletonRows } from "../components/Skeleton";
import { formatCompact, formatSandboxTime, formatUsd } from "../lib/format";

// ── Wire shapes — mirror apps/main/src/routes/usage.ts (UsageSummary) and
//    packages/cf-billing/src/cf-analytics.ts (CostReport). Neither endpoint
//    has a typed SDK client, so these are hand-mirrored the same way
//    AgentObservabilityTab mirrors SessionAnalytics. ─────────────────────
interface UsageByKind {
  kind: string;
  total_seconds: number;
}
interface UsageByInstanceType {
  instance_type: string | null;
  total_seconds: number;
}
interface DailyBucket {
  date: string;
  active_seconds: number;
  runs: number;
}
interface UsageSummary {
  total_active_seconds: number;
  total_sessions: number;
  by_kind: UsageByKind[];
  by_instance_type: UsageByInstanceType[];
  daily: DailyBucket[];
}

interface ServiceCost {
  usage: Record<string, number>;
  included: Record<string, number>;
  cost: number;
  breakdown?: Array<Record<string, unknown>>;
}
interface CostReport {
  period: { start: string; end: string; days: number };
  platform_fee: number;
  services: Record<string, ServiceCost>;
  total_estimated_cost: number;
}

type Range = "7d" | "30d" | "90d";
const RANGES: Range[] = ["7d", "30d", "90d"];
const RANGE_DAYS: Record<Range, number> = { "7d": 7, "30d": 30, "90d": 90 };

// usage_events.kind -> display label + the unit its `value` column holds.
// Most kinds are raw seconds; the two model_* kinds hold a raw token count
// in the same column (see packages/services/src/usage.ts's UsageKind).
const KIND_META: Record<string, { label: string; unit: "seconds" | "tokens" }> = {
  sandbox_active_seconds: { label: "Sandbox active time", unit: "seconds" },
  browser_active_seconds: { label: "Browser active time", unit: "seconds" },
  session_alive_seconds: { label: "Session alive time", unit: "seconds" },
  model_input_tokens: { label: "Model input tokens", unit: "tokens" },
  model_output_tokens: { label: "Model output tokens", unit: "tokens" },
};

const SERVICE_LABELS: Record<string, string> = {
  workers: "Workers",
  durable_objects: "Durable Objects",
  kv: "KV",
  r2: "R2",
  d1: "D1",
  workers_ai: "Workers AI",
  browser_rendering: "Browser Rendering",
  containers: "Containers",
};

function kindValue(byKind: UsageByKind[], kind: string): number {
  return byKind.find((k) => k.kind === kind)?.total_seconds ?? 0;
}

function formatKindTotal(kind: string, value: number): string {
  return (KIND_META[kind]?.unit ?? "seconds") === "tokens"
    ? formatCompact(value)
    : formatSandboxTime(value);
}

/**
 * Tenant-wide usage & cost analytics (issue #174) — 4th tab in the Sessions
 * hub, alongside Sessions / Kanban Board / Eval Runs. There's no dedicated
 * top-level "Analytics" nav destination (the sidebar is deliberately capped
 * at 6 flat items — see AppSidebar.tsx), so this extends the closest
 * existing home rather than adding a 7th.
 *
 * Consumes:
 *   - GET /v1/usage — all-time totals + a fixed last-30-days daily series.
 *     No query params (confirmed against apps/main/src/routes/usage.ts) —
 *     only the daily chart's *window* is range-adjustable, done client-side
 *     since the server already caps `daily` at 30 days.
 *   - GET /v1/cost_report?days=N — genuinely range-scoped Cloudflare infra
 *     cost. Returns 501 when CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID
 *     aren't configured — treated as an explanatory empty state, not an
 *     error.
 *
 * Charts are hand-rolled inline SVG, matching AgentObservabilityTab — no
 * chart library. Error/retry states follow the Dashboard/#218 pattern
 * (each independent fetch renders its own loading/error/empty state so one
 * flaky endpoint doesn't hide the other's data).
 */
export function Usage() {
  const [range, setRange] = useState<Range>("30d");
  const days = RANGE_DAYS[range];

  const usageQuery = useApiQuery<UsageSummary>("/v1/usage");
  const costQuery = useApiQuery<CostReport>("/v1/cost_report", { days: String(days) });

  const usage = usageQuery.data;
  const cost = costQuery.data;

  const inputTokens = usage ? kindValue(usage.by_kind, "model_input_tokens") : 0;
  const outputTokens = usage ? kindValue(usage.by_kind, "model_output_tokens") : 0;

  const dailySlice = useMemo(() => usage?.daily.slice(-days) ?? [], [usage, days]);

  const isAllEmpty =
    !!usage &&
    usage.total_sessions === 0 &&
    usage.total_active_seconds === 0 &&
    usage.by_kind.length === 0;

  const costNotConfigured =
    costQuery.error instanceof ApiError && costQuery.error.status === 501;

  return (
    <div className="pb-4 space-y-6">
      <div>
        <h2 className="font-display text-lg font-semibold text-fg">Usage &amp; cost</h2>
        <p className="text-sm text-fg-muted mt-0.5">
          Sandbox time, model tokens, and Cloudflare infra cost across every agent in this
          workspace.
        </p>
      </div>

      {/* Range picker — drives the daily-activity window (client-sliced;
          the server always returns the last 30 days) and the Cloudflare
          cost report's ?days= param. Rendered unconditionally, like the
          per-agent Observability tab's range chip, so a user stuck on an
          empty/error state for one range can try another without losing
          their place. */}
      <RangePicker range={range} onChange={setRange} />

      {usageQuery.isLoading && !usage ? (
        <UsageSkeleton />
      ) : usageQuery.error ? (
        <EmptyState
          title="Couldn't load usage"
          body={formatQueryError(usageQuery.error)}
          tone="danger"
          icon={<TriangleAlertIcon className="text-danger" />}
          action={<Button onClick={() => usageQuery.refetch()}>Retry</Button>}
        />
      ) : isAllEmpty || !usage ? (
        <EmptyState
          title="No usage in this period"
          body="Once agents run sessions, their sandbox time, tokens, and cost will appear here."
          size="lg"
        />
      ) : (
        <>
          <div>
            <h3 className="text-xs uppercase tracking-wider text-fg-subtle font-medium mb-2">
              All time
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 max-w-5xl">
              <StatCard
                label="Sandbox time"
                value={formatSandboxTime(usage.total_active_seconds)}
              />
              <StatCard
                label="Sessions with usage"
                value={formatCompact(usage.total_sessions)}
              />
              <StatCard label="Tokens in" value={formatCompact(inputTokens)} />
              <StatCard label="Tokens out" value={formatCompact(outputTokens)} />
            </div>
          </div>

          <Card title="Daily activity">
            <DailyChart data={dailySlice} />
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 max-w-5xl">
            <Card title="By kind">
              <KindTable rows={usage.by_kind} />
            </Card>
            <Card title="By sandbox instance type">
              <InstanceTypeTable rows={usage.by_instance_type} />
            </Card>
          </div>
        </>
      )}

      <Card title="Cloudflare cost">
        {costQuery.isLoading && !cost ? (
          <SkeletonRows count={3} />
        ) : costNotConfigured ? (
          <EmptyState
            size="sm"
            title="Cloudflare cost reporting isn't configured"
            body="Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID on this deployment to see priced Cloudflare resource consumption here."
          />
        ) : costQuery.error ? (
          <EmptyState
            size="sm"
            tone="danger"
            title="Couldn't load Cloudflare cost"
            body={formatQueryError(costQuery.error)}
            icon={<TriangleAlertIcon className="text-danger" />}
            action={<Button onClick={() => costQuery.refetch()}>Retry</Button>}
          />
        ) : cost ? (
          <>
            <div className="mb-3">
              <div className="text-lg font-semibold text-fg tabular-nums">
                {formatUsd(cost.total_estimated_cost)}
              </div>
              <div className="text-xs text-fg-subtle">
                {cost.period.start} – {cost.period.end} · incl.{" "}
                {formatUsd(cost.platform_fee)} platform fee
              </div>
            </div>
            <ServiceCostTable services={cost.services} />
          </>
        ) : null}
      </Card>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-border rounded-lg bg-bg-surface/30 px-4 py-3">
      <div className="text-xs text-fg-muted uppercase tracking-wider">{label}</div>
      <div className="text-lg font-semibold text-fg mt-0.5 tabular-nums">{value}</div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border border-border rounded-lg bg-bg-surface/30 p-4 max-w-5xl">
      <h3 className="font-display text-base font-semibold mb-3">{title}</h3>
      {children}
    </div>
  );
}

function RangePicker({ range, onChange }: { range: Range; onChange: (r: Range) => void }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-fg-subtle">Range</span>
      <div className="inline-flex items-center gap-1 rounded-lg bg-muted p-[3px]">
        {RANGES.map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => onChange(r)}
            className={cn(
              "px-2.5 py-1 rounded-md text-xs font-medium transition-all",
              range === r
                ? "bg-background text-foreground shadow-sm"
                : "text-foreground/60 hover:text-foreground",
            )}
          >
            {r}
          </button>
        ))}
      </div>
    </div>
  );
}

function UsageSkeleton() {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 max-w-5xl">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="border border-border rounded-lg bg-bg-surface/30 px-4 py-3">
            <Skeleton className="h-3 w-20" rounded="sm" />
            <Skeleton className="h-6 w-16 mt-2" rounded="sm" />
          </div>
        ))}
      </div>
      <SkeletonRows count={4} />
    </div>
  );
}

/** Bar chart of daily sandbox-active-seconds — same hand-rolled inline-SVG
 *  approach as AgentObservabilityTab's ActivityChart (bars + baseline +
 *  `<title>` tooltips + thinned date labels), no chart library. */
function DailyChart({ data }: { data: DailyBucket[] }) {
  const n = data.length;
  if (n === 0) return <p className="text-sm text-fg-subtle">No data.</p>;

  const max = Math.max(1, ...data.map((d) => d.active_seconds));
  const slot = 12; // user units per bucket
  const barW = 8;
  const chartTop = 8;
  const chartH = 100; // plot area height
  const baseline = chartTop + chartH;
  const labelStep = Math.max(1, Math.round(n / 6));
  const totalW = n * slot;

  const fmtDate = (iso: string) => {
    const d = new Date(iso);
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  };

  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${totalW} ${baseline + 22}`}
        width="100%"
        height={baseline + 22}
        preserveAspectRatio="none"
        role="img"
        aria-label="Daily sandbox activity"
      >
        <line
          x1={0}
          y1={baseline}
          x2={totalW}
          y2={baseline}
          stroke="var(--color-border)"
          strokeWidth={1}
        />
        {data.map((d, i) => {
          const h = max > 0 ? (d.active_seconds / max) * chartH : 0;
          const x = i * slot + (slot - barW) / 2;
          const y = baseline - h;
          return (
            <g key={d.date}>
              <rect
                x={x}
                y={y}
                width={barW}
                height={Math.max(h, d.active_seconds > 0 ? 1 : 0)}
                rx={1.5}
                fill="var(--color-brand)"
                opacity={0.85}
              >
                <title>{`${fmtDate(d.date)}: ${formatSandboxTime(d.active_seconds)} · ${d.runs} run${d.runs === 1 ? "" : "s"}`}</title>
              </rect>
              {i % labelStep === 0 && (
                <text
                  x={i * slot + slot / 2}
                  y={baseline + 14}
                  textAnchor="middle"
                  fontSize={7}
                  fill="var(--color-fg-subtle)"
                >
                  {fmtDate(d.date)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function KindTable({ rows }: { rows: UsageByKind[] }) {
  if (rows.length === 0) return <p className="text-sm text-fg-subtle">No usage recorded.</p>;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-fg-subtle text-[11px] uppercase tracking-[0.08em]">
          <th className="text-left pb-2 font-medium">Kind</th>
          <th className="text-right pb-2 font-medium">Total</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.kind} className="border-t border-border">
            <td className="py-2 text-fg">{KIND_META[r.kind]?.label ?? r.kind}</td>
            <td className="py-2 text-right text-fg-muted tabular-nums">
              {formatKindTotal(r.kind, r.total_seconds)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function InstanceTypeTable({ rows }: { rows: UsageByInstanceType[] }) {
  if (rows.length === 0)
    return <p className="text-sm text-fg-subtle">No sandbox usage recorded.</p>;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-fg-subtle text-[11px] uppercase tracking-[0.08em]">
          <th className="text-left pb-2 font-medium">Instance type</th>
          <th className="text-right pb-2 font-medium">Active time</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.instance_type ?? "unknown"} className="border-t border-border">
            <td className="py-2 text-fg font-mono text-xs">{r.instance_type ?? "unknown"}</td>
            <td className="py-2 text-right text-fg-muted tabular-nums">
              {formatSandboxTime(r.total_seconds)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Per-Cloudflare-service cost breakdown — /v1/cost_report groups by CF
 *  service (workers, durable_objects, kv, ...), not by agent or model
 *  (usage_events records neither model id nor a cost figure), so this is
 *  the grouping the API actually provides. Each service's `usage` record
 *  has different keys (requests/errors for workers, read/write/storage_gb
 *  for kv, ...) — joined generically rather than special-cased per
 *  service. */
function ServiceCostTable({ services }: { services: Record<string, ServiceCost> }) {
  const rows = Object.entries(services);
  if (rows.length === 0)
    return <p className="text-sm text-fg-subtle">No Cloudflare service usage recorded.</p>;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-fg-subtle text-[11px] uppercase tracking-[0.08em]">
          <th className="text-left pb-2 font-medium">Service</th>
          <th className="text-left pb-2 font-medium">Usage</th>
          <th className="text-right pb-2 font-medium">Cost</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([key, svc]) => (
          <tr key={key} className="border-t border-border">
            <td className="py-2 text-fg">{SERVICE_LABELS[key] ?? key}</td>
            <td className="py-2 text-fg-muted text-xs">
              {Object.entries(svc.usage)
                .map(([k, v]) => `${k}: ${formatCompact(v)}`)
                .join(" · ") || "—"}
            </td>
            <td className="py-2 text-right text-fg-muted tabular-nums">
              {formatUsd(svc.cost)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
