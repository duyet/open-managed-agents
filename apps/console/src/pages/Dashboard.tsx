import { useNavigate } from "react-router";
import { useAuth } from "../lib/auth";
import { useApiQuery } from "../lib/useApiQuery";
import { StatusPill } from "../components/Badge";
import { EmptyState } from "../components/EmptyState";
import { Skeleton } from "../components/Skeleton";
import { StackedAssembly } from "../components/StackedAssembly";
import { Card, CardContent } from "../components/ui/card";
import { formatSandboxTime } from "../lib/format";

interface Stats {
  agents: number;
  sessions: number;
  environments: number;
  vaults: number;
  skills: number;
  model_cards: number;
  api_keys: number;
  /** Cumulative sandbox seconds across all usage_events, all time. */
  total_sandbox_seconds: number;
  /** Distinct sessions with any recorded usage, all time. */
  total_usage_sessions: number;
}

interface RecentSession {
  id: string;
  title: string;
  agent_id: string;
  status: string;
  created_at: string;
}

export function Dashboard() {
  const nav = useNavigate();
  const { user: _user } = useAuth();
  // Headline cards + recent panel each ride their own TQ query so the
  // dashboard renders the parts it has — a flaky /v1/stats no longer
  // blocks the recent-sessions panel and vice versa. The previous
  // hand-rolled `Promise.all` + single `loading` boolean made one failure
  // hide both panels.
  const statsQuery = useApiQuery<Stats>("/v1/stats");
  const sessionsQuery = useApiQuery<{ data: RecentSession[] }>(
    "/v1/sessions",
    { limit: "5" },
  );
  // "Active sessions" isn't part of /v1/stats — there's no bespoke
  // analytics endpoint to ask for it, so derive it from a filtered
  // /v1/sessions?status=running page instead. `next_page` presence means
  // there are more than `limit` running sessions right now; render that
  // as "N+" rather than silently under-counting.
  const runningSessionsQuery = useApiQuery<{
    data: RecentSession[];
    next_page?: string;
  }>("/v1/sessions", { status: "running", limit: "100" });
  const stats = statsQuery.data ?? null;
  const recentSessions = sessionsQuery.data?.data.slice(0, 5) ?? [];

  const runningCount = runningSessionsQuery.data?.data.length;
  const runningHasMore = Boolean(runningSessionsQuery.data?.next_page);

  const metrics = [
    {
      label: "Sandbox time",
      value: formatSandboxTime(stats?.total_sandbox_seconds),
      caption: stats?.total_sandbox_seconds ? "all time" : "No usage yet",
      isLoading: statsQuery.isLoading,
    },
    {
      label: "Sessions run",
      value: (stats?.total_usage_sessions ?? 0).toLocaleString(),
      caption: stats?.total_usage_sessions ? "all time" : "No usage yet",
      isLoading: statsQuery.isLoading,
    },
    {
      label: "Active sessions",
      value: `${runningCount ?? 0}${runningHasMore ? "+" : ""}`,
      caption: "right now",
      isLoading: runningSessionsQuery.isLoading,
    },
    {
      label: "Agents",
      value: (stats?.agents ?? 0).toLocaleString(),
      caption: stats?.agents ? "total" : "No agents yet",
      isLoading: statsQuery.isLoading,
    },
  ];

  const stat = (label: string, value: number | undefined, to: string) => (
    <button
      key={label}
      onClick={() => nav(to)}
      className="group relative text-left px-4 py-3.5 border border-border rounded-md bg-bg hover:border-border-strong hover:bg-bg-surface/40 active:translate-y-px transition-[color,background-color,border-color,transform] duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
    >
      <div className="font-display text-[28px] leading-none font-semibold text-fg group-hover:text-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] tabular-nums">
        {value ?? "–"}
      </div>
      <div className="mt-2 text-[11px] uppercase tracking-[0.08em] text-fg-muted font-medium">
        {label}
      </div>
    </button>
  );

  const stats_ = [
    { label: "Agents", value: stats?.agents, to: "/agents" },
    { label: "Sessions", value: stats?.sessions, to: "/sessions" },
    { label: "Environments", value: stats?.environments, to: "/environments" },
    { label: "Vaults", value: stats?.vaults, to: "/vaults" },
    { label: "Skills", value: stats?.skills, to: "/skills" },
    { label: "Model Cards", value: stats?.model_cards, to: "/model-cards" },
  ];

  return (
    <div className="pb-4">
      <div className="space-y-10 pt-3">
        {/* Header */}
        <header>
          <h1 className="font-display text-[32px] leading-tight font-semibold tracking-tight text-fg">
            Get started with oma
          </h1>
          <p className="mt-1.5 text-[15px] text-fg-muted">
            Configure the pieces below, compose them into an agent, and every
            conversation runs as a session inside a sandbox. Click any box to
            set it up. CLI install steps live on the{" "}
            <button
              onClick={() => nav("/runtimes")}
              className="text-brand hover:underline"
            >
              Sandbox Runtime page
            </button>
            .
          </p>
        </header>

        {/* Headline metrics — prominent, number-forward cards leading the
            page (Claude Console home pattern). All values come from the
            existing /v1/stats + /v1/sessions endpoints; no new backend
            surface. Purely informational (unlike the resource-count row
            below), so no click-to-navigate here. */}
        <section>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {metrics.map((m) => (
              <Card
                key={m.label}
                data-testid={`metric-card-${m.label}`}
                className="bg-bg-surface/40"
              >
                <CardContent className="py-0.5">
                  {m.isLoading ? (
                    <Skeleton className="h-8 w-20" rounded="sm" />
                  ) : (
                    <div className="font-display text-[32px] leading-none font-semibold text-fg tabular-nums">
                      {m.value}
                    </div>
                  )}
                  <div className="mt-2.5 text-[11px] uppercase tracking-[0.08em] text-fg-muted font-medium">
                    {m.label}
                  </div>
                  <div className="mt-0.5 text-[12px] text-fg-subtle">
                    {m.caption}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        {/* How it fits together — numbered setup-steps grid: three step
            columns ordered by setup dependency (① Foundation → ② Agent →
            ③ Reach). Each card is a component type with its real instances
            as badges; step headers check off as required cards go green —
            the conceptual map and the setup checklist in one panel. */}
        <StackedAssembly />

        {/* Stats — number-forward, no decorative icons */}
        <section>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
            {stats_.map((s) => stat(s.label, s.value, s.to))}
          </div>
        </section>

        {/* Recent sessions */}
        <section>
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="font-display text-lg font-semibold text-fg">Recent sessions</h2>
            <button
              onClick={() => nav("/sessions")}
              className="group/cta inline-flex items-center gap-1 min-h-11 sm:min-h-0 text-[13px] text-fg-muted hover:text-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
            >
              View all
              <span className="transition-transform duration-[var(--dur-quick)] ease-[var(--ease-soft)] group-hover/cta:translate-x-0.5">
                →
              </span>
            </button>
          </div>

          {sessionsQuery.isLoading ? (
            <div className="border border-border rounded-lg divide-y divide-border">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4 px-4 py-3">
                  <Skeleton className="h-3.5 w-[40%]" rounded="sm" />
                  <Skeleton className="h-3.5 w-16" rounded="sm" />
                  <Skeleton className="h-3.5 w-32" rounded="sm" />
                  <Skeleton className="h-3.5 w-20 ml-auto" rounded="sm" />
                </div>
              ))}
            </div>
          ) : recentSessions.length === 0 ? (
            <EmptyState
              title="No sessions yet — the stable's empty."
              body={
                <>
                  Tell your agent to start one, or visit the{" "}
                  <button
                    onClick={() => nav("/sessions")}
                    className="inline-flex items-center min-h-11 sm:min-h-0 text-brand hover:underline"
                  >
                    Sessions page
                  </button>
                  .
                </>
              }
            />
          ) : (
            <div className="border border-border rounded-lg overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-bg-surface/40 text-fg-subtle text-[11px] uppercase tracking-[0.08em]">
                    <th className="text-left px-4 py-2.5 font-medium">Title</th>
                    <th className="text-left px-4 py-2.5 font-medium">Status</th>
                    <th className="text-left px-4 py-2.5 font-medium">Agent</th>
                    <th className="text-left px-4 py-2.5 font-medium">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {recentSessions.map((s) => (
                    <tr
                      key={s.id}
                      onClick={() => nav(`/sessions/${s.id}`)}
                      className="border-t border-border hover:bg-bg-surface/40 cursor-pointer transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
                    >
                      <td className="px-4 py-2.5 text-fg">{s.title || "Untitled"}</td>
                      <td className="px-4 py-2.5">
                        <StatusPill status={s.status || "idle"} />
                      </td>
                      <td className="px-4 py-2.5 text-fg-muted font-mono text-[12px]">
                        {s.agent_id}
                      </td>
                      <td className="px-4 py-2.5 text-fg-muted text-[12px]">
                        {new Date(s.created_at).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
