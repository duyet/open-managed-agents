import { useMemo, useState } from "react";
import { useParams, Link, useNavigate } from "react-router";
import { useApi } from "../lib/api";
import { useApiQuery } from "../lib/useApiQuery";
import { GitHubIcon, LinearIcon, SlackIcon } from "../components/icons";
import { Page } from "../components/Page";
import { PageHeader } from "../components/PageHeader";
import { Button } from "@/components/ui/button";
import { AgentWebhooks } from "./agents/AgentWebhooks";
import { AgentEditDialog } from "./agents/AgentEditDialog";
import type { AgentRecord as Agent } from "../types/agent";

/** GET /v1/agents/:id/stats response — see apps/main/src/routes/agent-stats.ts. */
interface AgentStats {
  sessions: number;
  input_tokens: number;
  output_tokens: number;
  sandbox_seconds: number;
  est_model_cost_usd: number;
  est_sandbox_cost_usd: number;
}

/** GET /v1/agents/:id/runs item — session summary for this agent. */
interface AgentRun {
  id: string;
  title: string;
  status: string;
  stop_reason: string | null;
  tool_call_count: number | null;
  message_count: number | null;
  duration_ms: number;
  created_at: string;
}

/** Shared publication shape across Linear / GitHub / Slack — they all
 *  expose the same id / status / mode / persona / workspace_name fields. */
interface Pub {
  id: string;
  status: string;
  mode: string;
  persona: { name: string; avatarUrl: string | null };
  workspace_name: string | null;
}

export function AgentDetail() {
  const { id } = useParams();
  const { api } = useApi();
  const nav = useNavigate();

  // Single-resource fetches via TQ. `enabled: !!id` defers until the route
  // param is available; the publication queries inherit the same gate.
  // Each query runs independently — failures on the publication endpoints
  // (404 / not-installed) don't block the agent detail render, same as
  // the previous behavior where each had its own .catch.
  const enabled = !!id;
  const { data: agent, error: agentError, refetch: refetchAgent } = useApiQuery<Agent>(
    id ? `/v1/agents/${id}` : null,
    undefined,
    { enabled },
  );
  const { data: stats, refetch: refetchStats } = useApiQuery<AgentStats>(
    id ? `/v1/agents/${id}/stats` : null,
    undefined,
    { enabled },
  );
  const { data: runsRes, refetch: refetchRuns } = useApiQuery<{
    data: AgentRun[];
    has_more: boolean;
  }>(id ? `/v1/agents/${id}/runs?limit=20` : null, undefined, { enabled });
  const { data: versionsRes, refetch: refetchVersions } = useApiQuery<{ data: Agent[] }>(
    id ? `/v1/agents/${id}/versions` : null,
    undefined,
    { enabled },
  );
  // Reverse-lookup publications per provider. Each endpoint exists thanks
  // to the /linear/agents/:id/publications + /slack/agents/:id/publications
  // + /github/agents/:id/publications routes added on the main worker.
  const { data: linearRes } = useApiQuery<{ data: Pub[] }>(
    id ? `/v1/integrations/linear/agents/${id}/publications` : null,
    undefined,
    { enabled },
  );
  const { data: githubRes } = useApiQuery<{ data: Pub[] }>(
    id ? `/v1/integrations/github/agents/${id}/publications` : null,
    undefined,
    { enabled },
  );
  const { data: slackRes } = useApiQuery<{ data: Pub[] }>(
    id ? `/v1/integrations/slack/agents/${id}/publications` : null,
    undefined,
    { enabled },
  );

  const versions = versionsRes?.data ?? [];
  // Filter to live publications only — same predicate the old useEffect ran.
  const linearPubs = useMemo(
    () => (linearRes?.data ?? []).filter((p) => p.status === "live"),
    [linearRes],
  );
  const githubPubs = useMemo(
    () => (githubRes?.data ?? []).filter((p) => p.status === "live"),
    [githubRes],
  );
  const slackPubs = useMemo(
    () => (slackRes?.data ?? []).filter((p) => p.status === "live"),
    [slackRes],
  );

  const error = agentError instanceof Error ? agentError.message : agentError ? String(agentError) : "";

  const modelStr = (m: Agent["model"]) => typeof m === "string" ? m : `${m?.id} (${m?.speed || "standard"})`;

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);

  const createSession = async () => {
    setCreating(true);
    try {
      const session = await api<{ id: string }>("/v1/sessions", {
        method: "POST",
        body: JSON.stringify({ agent: id }),
      });
      nav(`/sessions/${session.id}`);
    } catch {
      setCreating(false);
    }
  };

  const archive = async () => {
    if (!confirm("Archive this agent?")) return;
    await api(`/v1/agents/${id}/archive`, { method: "POST", body: "{}" });
    nav("/agents");
  };

  const del = async () => {
    if (!confirm("Delete this agent? This cannot be undone.")) return;
    await api(`/v1/agents/${id}`, { method: "DELETE" });
    nav("/agents");
  };

  if (error) return <div className="p-10 text-danger">Error: {error}</div>;
  if (!agent) return <div className="p-10 text-fg-subtle">Loading...</div>;

  return (
    <Page
      header={
        <PageHeader
          title={agent.name}
          actions={
            <>
              <Button variant="default" size="sm" onClick={createSession} disabled={creating}>
                {creating ? "Creating…" : "+ New Session"}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                Edit
              </Button>
              <Button variant="outline" size="sm" onClick={archive}>
                Archive
              </Button>
              <Button variant="destructive" size="sm" onClick={del}>
                Delete
              </Button>
            </>
          }
        />
      }
    >
      <div className="space-y-6">
        {/* Usage analytics — sessions / tokens / cost estimates from
            GET /v1/agents/:id/stats. Plain bordered cards. */}
        {stats && (
          <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3 max-w-5xl">
            <StatCard label="Sessions" value={fmtNum(stats.sessions)} />
            <StatCard label="Tokens in" value={fmtNum(stats.input_tokens)} />
            <StatCard label="Tokens out" value={fmtNum(stats.output_tokens)} />
            <StatCard label="Est. model cost" value={fmtUsd(stats.est_model_cost_usd)} />
            <StatCard label="Sandbox time" value={fmtDuration(stats.sandbox_seconds * 1000)} />
            <StatCard label="Est. sandbox cost" value={fmtUsd(stats.est_sandbox_cost_usd)} />
          </div>
        )}

        {/* Properties grid */}
        <div className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-2 max-w-2xl text-sm">
          <span className="text-fg-muted">ID</span><span className="font-mono text-xs">{agent.id}</span>
          {agent.description && (
            <><span className="text-fg-muted">Description</span><span>{agent.description}</span></>
          )}
          <span className="text-fg-muted">Model</span><span>{modelStr(agent.model)}</span>
          {agent._oma?.aux_model && (
            <><span className="text-fg-muted">Aux Model</span><span>{modelStr(agent._oma.aux_model)}</span></>
          )}
          <span className="text-fg-muted">Harness</span><span>{agent._oma?.harness || "default"}</span>
          {agent._oma?.runtime_binding && (
            <>
              <span className="text-fg-muted">Local Runtime</span>
              <span className="text-xs">
                <span className="font-mono">{agent._oma.runtime_binding.runtime_id.slice(0, 8)}…</span>
                <span className="text-fg-subtle"> · ACP agent: </span>
                <span className="font-mono">{agent._oma.runtime_binding.acp_agent_id}</span>
              </span>
            </>
          )}
          <span className="text-fg-muted">Version</span><span>v{agent.version}</span>
          <span className="text-fg-muted">Tools</span>
          <span>{(agent.tools || []).map((t: any) => t.type === "custom" ? `Custom: ${t.name}` : t.type).join(", ") || "None"}</span>
          {(agent.skills?.length ?? 0) > 0 && (
            <>
              <span className="text-fg-muted">Skills</span>
              <span>{(agent.skills as Array<{ skill_id: string }>).map((s) => s.skill_id).join(", ")}</span>
            </>
          )}
          {(agent.mcp_servers?.length ?? 0) > 0 && (
            <>
              <span className="text-fg-muted">MCP Servers</span>
              <span>{(agent.mcp_servers as Array<{ name: string }>).map((m) => m.name).join(", ")}</span>
            </>
          )}
          {(agent.multiagent?.agents?.length ?? 0) > 0 && (
            <>
              <span className="text-fg-muted">Callable Agents</span>
              <span className="font-mono text-xs">
                {agent.multiagent!.agents.map((a) => a.id).join(", ")}
              </span>
            </>
          )}
          {agent.metadata && Object.keys(agent.metadata).length > 0 && (
            <>
              <span className="text-fg-muted">Metadata</span>
              <span className="font-mono text-xs whitespace-pre-wrap">
                {JSON.stringify(agent.metadata)}
              </span>
            </>
          )}
          <span className="text-fg-muted">Created</span><span>{new Date(agent.created_at).toLocaleString()}</span>
          <span className="text-fg-muted">Updated</span><span>{new Date(agent.updated_at || agent.created_at).toLocaleString()}</span>
          {agent.archived_at && <><span className="text-fg-muted">Archived</span><span className="text-warning">{new Date(agent.archived_at).toLocaleString()}</span></>}
        </div>

      {/* Two-column on xl: integrations + webhooks left, system prompt +
          version history right — uses wide screens instead of one long
          scroll. Collapses back to a single column below xl. */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-x-8 items-start">
      <div className="min-w-0">
      {/* Integrations — one fold per provider so adding a 4th / 5th doesn't
          push the rest of the page below the viewport. Default-open when
          there's at least one live publication so the user sees what's wired
          up at a glance; otherwise default-closed. */}
      <div className="mt-6 max-w-2xl">
        <h2 className="font-display text-base font-semibold mb-2">Integrations</h2>
        <div className="space-y-2">
          <IntegrationFold
            kind="linear"
            label="Linear"
            icon={<LinearIcon className="w-4 h-4" />}
            pubs={linearPubs}
            agentId={agent.id}
          />
          <IntegrationFold
            kind="github"
            label="GitHub"
            icon={<GitHubIcon className="w-4 h-4" />}
            pubs={githubPubs}
            agentId={agent.id}
          />
          <IntegrationFold
            kind="slack"
            label="Slack"
            icon={<SlackIcon className="w-4 h-4" />}
            pubs={slackPubs}
            agentId={agent.id}
          />
        </div>
      </div>

      <AgentWebhooks agent={agent} />
      </div>

      <div className="min-w-0">
      {/* System prompt */}
      {agent.system && (
        <div className="mt-6 xl:mt-6 max-w-2xl">
          <h2 className="font-display text-base font-semibold mb-2">System Prompt</h2>
          <pre className="bg-bg-surface border border-border rounded-lg p-4 text-sm whitespace-pre-wrap max-h-64 overflow-y-auto font-mono text-fg-muted leading-relaxed">
            {agent.system}
          </pre>
        </div>
      )}

      {/* Version history */}
      {versions.length > 0 && (
        <div className="mt-8 max-w-2xl">
          <h2 className="font-display text-base font-semibold mb-2">Version History</h2>
          <div className="border border-border rounded-lg overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-bg-surface/60 text-fg-muted text-xs uppercase tracking-wider">
                  <th className="text-left px-4 py-2">Version</th>
                  <th className="text-left px-4 py-2">Model</th>
                  <th className="text-left px-4 py-2">System Prompt</th>
                </tr>
              </thead>
              <tbody>
                {versions.map((v) => (
                  <tr key={v.version} className="border-t border-border">
                    <td className="px-4 py-2">v{v.version}</td>
                    <td className="px-4 py-2 text-fg-muted">{modelStr(v.model)}</td>
                    <td className="px-4 py-2 text-fg-muted max-w-xs truncate">{v.system || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      </div>
      </div>

      {/* Sessions belonging to this agent — GET /v1/agents/:id/runs. */}
      <div className="mt-2">
        <h2 className="font-display text-base font-semibold mb-2">Sessions</h2>
        {(runsRes?.data?.length ?? 0) === 0 ? (
          <p className="text-sm text-fg-subtle">No sessions yet.</p>
        ) : (
          <div className="border border-border rounded-lg overflow-x-auto max-w-5xl">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-bg-surface/60 text-fg-muted text-xs uppercase tracking-wider">
                  <th className="text-left px-4 py-2">Session</th>
                  <th className="text-left px-4 py-2">Status</th>
                  <th className="text-left px-4 py-2">Stop Reason</th>
                  <th className="text-right px-4 py-2">Tools</th>
                  <th className="text-right px-4 py-2">Messages</th>
                  <th className="text-right px-4 py-2">Duration</th>
                  <th className="text-left px-4 py-2">Created</th>
                </tr>
              </thead>
              <tbody>
                {runsRes!.data.map((r) => (
                  <tr key={r.id} className="border-t border-border hover:bg-bg-surface/40">
                    <td className="px-4 py-2">
                      <Link to={`/sessions/${r.id}`} className="text-brand hover:underline">
                        {r.title || r.id.slice(0, 16)}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-fg-muted">{r.status}</td>
                    <td className="px-4 py-2 text-fg-muted">{r.stop_reason ?? "—"}</td>
                    <td className="px-4 py-2 text-right text-fg-muted">{r.tool_call_count ?? "—"}</td>
                    <td className="px-4 py-2 text-right text-fg-muted">{r.message_count ?? "—"}</td>
                    <td className="px-4 py-2 text-right text-fg-muted">{fmtDuration(r.duration_ms)}</td>
                    <td className="px-4 py-2 text-fg-muted">{new Date(r.created_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {runsRes?.has_more && (
          <p className="text-xs text-fg-subtle mt-2">
            Showing the 20 most recent sessions.{" "}
            <Link to="/sessions" className="text-brand hover:underline">
              See all sessions →
            </Link>
          </p>
        )}
      </div>
      </div>

      <AgentEditDialog
        open={editing}
        onClose={() => setEditing(false)}
        agent={agent}
        onSaved={() => {
          refetchAgent();
          refetchVersions();
          refetchStats();
          refetchRuns();
        }}
      />
    </Page>
  );
}

/** Compact bordered stat card for the usage analytics row. */
function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-border rounded-lg bg-bg-surface/30 px-4 py-3">
      <div className="text-xs text-fg-muted uppercase tracking-wider">{label}</div>
      <div className="text-lg font-semibold text-fg mt-0.5 tabular-nums">{value}</div>
    </div>
  );
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function fmtUsd(n: number): string {
  if (n > 0 && n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/**
 * One foldable provider section. Default-open when there's a live
 * publication, default-closed otherwise — opening an empty section
 * just to find the "Publish to X" link is wasteful.
 */
function IntegrationFold({
  kind,
  label,
  icon,
  pubs,
  agentId,
}: {
  kind: "linear" | "github" | "slack";
  label: string;
  icon: React.ReactNode;
  pubs: Pub[];
  agentId: string;
}) {
  return (
    <details
      open={pubs.length > 0}
      className="border border-border rounded-lg bg-bg-surface/30 [&_summary::-webkit-details-marker]:hidden"
    >
      <summary className="px-4 py-2.5 min-h-11 sm:min-h-0 flex items-center gap-3 text-sm cursor-pointer hover:bg-bg-surface/60 list-none">
        <span className="text-fg-muted shrink-0">{icon}</span>
        <span className="font-medium text-fg">{label}</span>
        <span className="ml-auto text-xs text-fg-subtle">
          {pubs.length === 0 ? "Not published" : `${pubs.length} live`}
        </span>
      </summary>
      <div className="px-4 pb-3 pt-2 border-t border-border/40 space-y-1.5 text-sm">
        {pubs.length === 0 ? (
          <Link
            to={`/integrations/${kind}/publish?agent_id=${agentId}`}
            className="inline-flex items-center gap-1.5 min-h-11 sm:min-h-0 text-brand hover:underline"
          >
            Publish to {label} →
          </Link>
        ) : (
          <>
            {pubs.map((p) => (
              <Link
                key={p.id}
                to={`/integrations/${kind}`}
                className="flex items-center gap-2 min-h-11 sm:min-h-0 text-fg-muted hover:text-fg"
              >
                <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-success-subtle text-success">
                  Live
                </span>
                <span>
                  as <strong>{p.persona.name}</strong> in {p.workspace_name ?? `${label} workspace`}
                </span>
                {p.mode === "full" && (
                  <span className="text-xs text-fg-subtle">(full identity)</span>
                )}
              </Link>
            ))}
            <Link
              to={`/integrations/${kind}/publish?agent_id=${agentId}`}
              className="inline-flex items-center min-h-11 sm:min-h-0 text-xs text-brand hover:underline pt-1"
            >
              + Publish to another workspace
            </Link>
          </>
        )}
      </div>
    </details>
  );
}
