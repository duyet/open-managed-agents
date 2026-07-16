import { useNavigate } from "react-router";
import { useAuth } from "../lib/auth";
import { useApiQuery } from "../lib/useApiQuery";
import { StatusPill } from "../components/Badge";
import { EmptyState } from "../components/EmptyState";
import { Skeleton } from "../components/Skeleton";

interface Stats {
  agents: number;
  sessions: number;
  environments: number;
  vaults: number;
  skills: number;
  model_cards: number;
  api_keys: number;
}

interface RecentSession {
  id: string;
  title: string;
  agent_id: string;
  status: string;
  created_at: string;
}

// One node in the "How it fits together" diagram. Clickable → navigates
// to the page where that component is configured.
function DiagramNode({
  label,
  hint,
  to,
  nav,
  accent,
  done,
}: {
  label: string;
  hint: string;
  to?: string;
  nav: (to: string) => void;
  accent?: boolean;
  done?: boolean;
}) {
  const base =
    "group relative w-full text-left rounded-md border px-3 py-2.5 active:translate-y-px transition-[color,background-color,border-color,transform] duration-[var(--dur-quick)] ease-[var(--ease-soft)]";
  const skin = accent
    ? "border-brand/50 bg-brand/5 hover:border-brand"
    : "border-border bg-bg hover:border-border-strong hover:bg-bg-surface/40";
  const inner = (
    <>
      <div className="flex items-center gap-1.5">
        <span className={`text-[13px] font-medium ${accent ? "text-brand" : "text-fg"}`}>
          {label}
        </span>
        {done !== undefined && (
          <span
            className={`shrink-0 w-3.5 h-3.5 rounded-full flex items-center justify-center text-[8px] leading-none ${
              done ? "bg-brand text-brand-fg" : "border border-border text-transparent"
            }`}
            title={done ? "Configured" : "Not set up yet"}
          >
            ✓
          </span>
        )}
      </div>
      <div className="mt-0.5 text-[11px] leading-snug text-fg-muted">{hint}</div>
    </>
  );
  if (!to) {
    return <div className={`${base} ${skin} cursor-default`}>{inner}</div>;
  }
  return (
    <button onClick={() => nav(to)} className={`${base} ${skin}`}>
      {inner}
    </button>
  );
}

function DiagramArrow({ down = false }: { down?: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={`flex items-center justify-center text-fg-subtle ${down ? "py-1" : "px-1"}`}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={down ? "rotate-90 md:rotate-90" : "rotate-90 md:rotate-0"}
      >
        <path d="M5 12h14M13 6l6 6-6 6" />
      </svg>
    </div>
  );
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
  const stats = statsQuery.data ?? null;
  const recentSessions = sessionsQuery.data?.data.slice(0, 5) ?? [];

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

        {/* How it fits together — clickable component map. Three stages:
            Configure (credentials + sandbox pieces) → Compose (agent)
            → Run (session in a sandbox). Checkmarks ride /v1/stats so a
            new user sees exactly what's still missing. */}
        <section className="border border-border rounded-lg p-5 md:p-6">
          <h2 className="font-display text-lg font-semibold text-fg">
            How it fits together
          </h2>
          <p className="mt-1 mb-5 text-[13px] text-fg-muted">
            You (or your agent, via the CLI + an API key) configure components;
            an agent ties them together; each task runs as a session in a sandbox.
          </p>

          <div className="flex flex-col md:flex-row md:items-stretch gap-1 md:gap-0">
            {/* Stage 1: Configure */}
            <div className="flex-1 min-w-0 rounded-md border border-dashed border-border p-3">
              <div className="font-mono text-[10px] tracking-wider text-fg-subtle mb-2">
                1 · CONFIGURE
              </div>
              <div className="space-y-2">
                <DiagramNode
                  nav={nav}
                  to="/api-keys"
                  label="API key"
                  hint="Auth for the CLI & your agent"
                  done={(stats?.api_keys ?? 0) > 0}
                />
                <DiagramNode
                  nav={nav}
                  to="/model-cards"
                  label="Model card"
                  hint="LLM provider credentials"
                  done={(stats?.model_cards ?? 0) > 0}
                />
                <DiagramNode
                  nav={nav}
                  to="/environments"
                  label="Environment"
                  hint="Packages, networking, resources"
                  done={(stats?.environments ?? 0) > 0}
                />
                <DiagramNode
                  nav={nav}
                  to="/skills"
                  label="Skills · Vaults"
                  hint="Optional: prompts, secrets, MCP"
                />
              </div>
            </div>

            <DiagramArrow />

            {/* Stage 2: Compose */}
            <div className="flex-1 min-w-0 rounded-md border border-dashed border-border p-3 flex flex-col">
              <div className="font-mono text-[10px] tracking-wider text-fg-subtle mb-2">
                2 · COMPOSE
              </div>
              <div className="flex-1 flex flex-col justify-center">
                <DiagramNode
                  nav={nav}
                  to="/agents"
                  label="Agent"
                  hint="Model + system prompt + tools + environment. Versioned config — the what, not the where."
                  accent
                  done={(stats?.agents ?? 0) > 0}
                />
              </div>
            </div>

            <DiagramArrow />

            {/* Stage 3: Run */}
            <div className="flex-1 min-w-0 rounded-md border border-dashed border-border p-3">
              <div className="font-mono text-[10px] tracking-wider text-fg-subtle mb-2">
                3 · RUN
              </div>
              <div className="space-y-2">
                <DiagramNode
                  nav={nav}
                  to="/sessions"
                  label="Session"
                  hint="One conversation / task — streamed, resumable event log"
                />
                <DiagramArrow down />
                <DiagramNode
                  nav={nav}
                  to="/runtimes"
                  label="Sandbox"
                  hint="Runs on a runtime provider — Cloudflare, K8s, or your own machine"
                />
              </div>
            </div>
          </div>
        </section>

        {/* First-session setup checklist — driven by /v1/stats so each
            item shows done/pending and links straight to its page. A first
            session needs: an API key (auth), a model card (LLM creds), an
            environment (sandbox), and an agent to run. Vaults/skills are
            optional polish, surfaced but not gating. */}
        <section>
          <h2 className="font-display text-lg font-semibold text-fg mb-3">
            Before your first session
          </h2>
          <div className="border border-border rounded-lg divide-y divide-border">
            {[
              {
                label: "API key",
                hint: "Mint a key so the CLI / your agent can authenticate.",
                to: "/api-keys",
                done: (stats?.api_keys ?? 0) > 0,
              },
              {
                label: "Model card",
                hint: "Add at least one card to provide LLM credentials for cloud agents.",
                to: "/model-cards",
                done: (stats?.model_cards ?? 0) > 0,
              },
              {
                label: "Environment",
                hint: "Create a sandbox environment (e.g. Cloudflare Sandbox) for agents to run in.",
                to: "/environments",
                done: (stats?.environments ?? 0) > 0,
              },
              {
                label: "Agent",
                hint: "Create an agent that ties a model card + environment together.",
                to: "/agents",
                done: (stats?.agents ?? 0) > 0,
              },
            ].map((item) => (
              <div
                key={item.label}
                className="flex items-center gap-3 px-4 py-3.5"
              >
                <span
                  className={`shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[11px] ${
                    item.done
                      ? "bg-brand text-brand-fg"
                      : "border border-border text-fg-subtle"
                  }`}
                >
                  {item.done ? "✓" : ""}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-fg">{item.label}</div>
                  <div className="text-xs text-fg-muted">{item.hint}</div>
                </div>
                <button
                  onClick={() => nav(item.to)}
                  className="group/cta inline-flex items-center gap-1 min-h-11 sm:min-h-0 text-[13px] text-fg-muted hover:text-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] shrink-0"
                >
                  {item.done ? "Manage" : "Set up"}
                  <span className="transition-transform duration-[var(--dur-quick)] ease-[var(--ease-soft)] group-hover/cta:translate-x-0.5">
                    →
                  </span>
                </button>
              </div>
            ))}
          </div>
        </section>

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
