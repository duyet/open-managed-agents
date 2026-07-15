import { useEffect, useMemo, useState } from "react";
import { XCircleIcon, TimerIcon } from "lucide-react";
import { useApi } from "../lib/api";
import { useApiQuery } from "../lib/useApiQuery";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PopoverContent } from "@/components/ui/popover";
import { Modal } from "../components/Modal";
import { DataTable, type ColumnDef } from "../components/DataTable";
import { FacetedFilter } from "../components/FacetedFilter";
import { FilterChip } from "../components/FilterChip";
import { RowActionsMenu } from "../components/RowActionsMenu";
import { cn } from "@/lib/utils";

interface LocalSkill {
  id: string;
  name?: string;
  description?: string;
  source?: "global" | "plugin" | "project";
  source_label?: string;
}

interface Runtime {
  id: string;
  machine_id: string;
  hostname: string;
  os: string;
  agents: Array<{ id: string; binary?: string }>;
  local_skills?: Record<string, LocalSkill[]>;
  version: string;
  status: "online" | "offline";
  last_heartbeat: number | null;
  created_at: number;
}

interface HostingType {
  id: string;
  label: string;
  description: string;
  type: "system" | "byok";
  provider: string;
  external: boolean;
  capabilities: string[];
  health: {
    status: "healthy" | "unhealthy" | "not_configured";
    latency_ms: number;
    last_checked: string;
    reason?: string;
  } | null;
}

const CAP_DISPLAY: Record<string, string> = {
  pause_resume: "Pause/Resume",
  cf_compatible: "CF Compatible",
  exec: "Exec",
  files: "Files",
};

const SYSTEM_PROVIDER_ENVS = [
  { env: "LITEBOX_MEMORY_MIB", label: "LiteBox (local micro-VM)" },
  { env: "BOXRUN_URL", label: "BoxRun (remote micro-VM)" },
  { env: "DAYTONA_API_KEY", label: "Daytona SaaS" },
  { env: "E2B_API_KEY", label: "E2B Firecracker microVM" },
  { env: "OMA_K8S_NAMESPACE", label: "Kubernetes" },
  { env: "K8S_BRIDGE_URL", label: "K8s Bridge (remote)" },
  { env: "DOCKER_COMPOSE_PROJECT_DIR", label: "Docker Compose" },
  { env: "GITHUB_ACTIONS_OWNER", label: "GitHub Actions sandbox" },
  { env: "REMOTE_AGENT_URL", label: "Remote Agent (BYOK)" },
];

type StatusValue = "any" | "online" | "offline";

const STATUS_OPTIONS: { value: StatusValue; label: string }[] = [
  { value: "any", label: "All" },
  { value: "online", label: "Online" },
  { value: "offline", label: "Offline" },
];

function formatHeartbeat(unixSeconds: number): string {
  const ago = Math.floor(Date.now() / 1000) - unixSeconds;
  if (ago < 60) return `${ago}s ago`;
  if (ago < 3600) return `${Math.floor(ago / 60)}m ago`;
  if (ago < 86400) return `${Math.floor(ago / 3600)}h ago`;
  return `${Math.floor(ago / 86400)}d ago`;
}

function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function ProviderCard({ p, onSetup }: { p: HostingType; onSetup?: (p: HostingType) => void }) {
  const health = p.health;
  const status = health?.status ?? "na";
  const healthDot =
    status === "healthy"
      ? "bg-success"
      : status === "unhealthy"
        ? "bg-destructive"
        : status === "not_configured"
          ? "bg-fg-subtle"
          : "bg-fg-subtle";
  const healthLabel =
    status === "healthy"
      ? "Healthy"
      : status === "unhealthy"
        ? "Unhealthy"
        : status === "not_configured"
          ? "Not configured"
          : "N/A";

  return (
    <Card size="sm" className="flex flex-col">
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="truncate">{p.label}</CardTitle>
            <div className="text-xs text-fg-subtle font-mono mt-0.5">{p.id}</div>
          </div>
          <span className={cn("shrink-0 w-2.5 h-2.5 rounded-full mt-1.5", healthDot)} title={healthLabel} />
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 flex-1">
        <p className="text-xs text-fg-muted leading-relaxed">{p.description}</p>

        <div className="flex flex-wrap gap-1">
          {p.type === "byok" && (
            <Badge variant="secondary" className="text-[10px]">BYOK</Badge>
          )}
          {p.external && (
            <Badge variant="outline" className="text-[10px]">External</Badge>
          )}
        </div>

        {p.capabilities.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {p.capabilities.map((cap) => (
              <Badge key={cap} variant="secondary" className="text-[10px]">
                {CAP_DISPLAY[cap] ?? cap}
              </Badge>
            ))}
          </div>
        )}

        <div className="mt-auto flex flex-col gap-2">
          {/* Status line */}
          <div className="flex items-center gap-3 text-[11px] text-fg-subtle">
            {health && (
              <>
                <span className="inline-flex items-center gap-1">
                  <span className={cn("w-1.5 h-1.5 rounded-full", healthDot)} />
                  {healthLabel}
                </span>
                {status === "healthy" && (
                  <>
                    <span className="inline-flex items-center gap-1">
                      <TimerIcon className="size-3" />
                      {formatLatency(health.latency_ms)}
                    </span>
                    <span className="font-mono">
                      {new Date(health.last_checked).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </>
                )}
              </>
            )}
            {!health && (
              <span className="inline-flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-fg-subtle" />
                Health N/A
              </span>
            )}
          </div>

          {/* Unhealthy reason */}
          {status === "unhealthy" && health?.reason && (
            <p className="text-[11px] text-destructive leading-relaxed rounded-md bg-destructive/10 px-2 py-1.5">
              {health.reason}
            </p>
          )}

          {/* Not configured → offer setup */}
          {status === "not_configured" && (
            <div className="flex flex-col gap-2">
              {health?.reason && (
                <p className="text-[11px] text-fg-muted leading-relaxed">
                  {health.reason}
                </p>
              )}
              {onSetup && (
                <Button size="sm" variant="secondary" className="w-full" onClick={() => onSetup(p)}>
                  Set up
                </Button>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function SkeletonCard() {
  return (
    <Card size="sm">
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="space-y-2 flex-1">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-20" />
          </div>
          <Skeleton className="shrink-0 w-2.5 h-2.5 rounded-full mt-1.5" />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-3/4" />
        <div className="flex gap-1">
          <Skeleton className="h-5 w-14 rounded-2xl" />
          <Skeleton className="h-5 w-16 rounded-2xl" />
        </div>
        <Skeleton className="h-3 w-24" />
      </CardContent>
    </Card>
  );
}

export function RuntimesList() {
  const { api } = useApi();
  const [showInstructions, setShowInstructions] = useState(false);
  const [status, setStatus] = useState<StatusValue>("any");
  const [setupProvider, setSetupProvider] = useState<HostingType | null>(null);

  const [providers, setProviders] = useState<HostingType[]>([]);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [providersError, setProvidersError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setProvidersLoading(true);
      setProvidersError(null);
      try {
        const res = await api<{ data: HostingType[] }>("/v1/hosting_types");
        if (!cancelled && Array.isArray(res.data)) {
          setProviders(res.data);
        }
      } catch (err) {
        if (!cancelled) {
          setProvidersError(err instanceof Error ? err.message : "Failed to load");
        }
      } finally {
        if (!cancelled) setProvidersLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [api]);

  const {
    data: runtimesRes,
    isLoading: loading,
    refetch,
  } = useApiQuery<{ runtimes: Runtime[] }>(
    "/v1/runtimes",
    undefined,
    { refetchInterval: 15_000 },
  );
  const runtimes = runtimesRes?.runtimes ?? [];

  const filtered = useMemo(
    () => (status === "any" ? runtimes : runtimes.filter((r) => r.status === status)),
    [runtimes, status],
  );

  const remove = async (id: string) => {
    if (!confirm("Revoke this runtime? Daemon on that machine will stop being able to attach.")) return;
    try {
      await api(`/v1/runtimes/${id}`, { method: "DELETE" });
      void refetch();
    } catch { /* ignore */ }
  };

  const columns = useMemo<ColumnDef<Runtime>[]>(
    () => [
      {
        id: "hostname",
        accessorKey: "hostname",
        header: "Hostname",
        cell: ({ row }) => {
          const r = row.original;
          const totalSkills = Object.values(r.local_skills ?? {}).reduce(
            (n, arr) => n + (arr?.length ?? 0),
            0,
          );
          return (
            <>
              <div className="font-medium text-fg">{r.hostname}</div>
              <div className="text-xs text-fg-subtle font-mono">{r.id}</div>
              {totalSkills > 0 && (
                <details className="mt-2 text-xs">
                  <summary className="cursor-pointer text-fg-muted hover:text-fg select-none">
                    {totalSkills} local skill{totalSkills === 1 ? "" : "s"} detected
                  </summary>
                  <div className="mt-1.5 ml-2 space-y-1.5">
                    {Object.entries(r.local_skills ?? {}).map(([acpId, skills]) =>
                      !skills?.length ? null : (
                        <div key={acpId}>
                          <div className="text-fg-subtle text-[10px] uppercase tracking-wider mb-0.5">
                            for {acpId}
                          </div>
                          <ul className="space-y-0.5">
                            {skills.map((s) => (
                              <li key={`${acpId}/${s.source_label ?? ""}/${s.id}`} className="font-mono">
                                <span className="text-fg">{s.id}</span>
                                <span className="text-fg-subtle ml-1">
                                  ({s.source ?? "global"}{s.source_label ? `:${s.source_label}` : ""})
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ),
                    )}
                  </div>
                </details>
              )}
            </>
          );
        },
        enableHiding: false,
      },
      {
        id: "os",
        accessorKey: "os",
        header: "OS",
        cell: ({ row }) => <span className="text-fg-muted">{row.original.os}</span>,
      },
      {
        id: "status",
        accessorFn: (r) => r.status,
        header: "Status",
        cell: ({ row }) => {
          const r = row.original;
          return (
            <span
              className={
                r.status === "online"
                  ? "inline-flex items-center gap-1.5 text-success text-xs font-medium"
                  : "inline-flex items-center gap-1.5 text-fg-subtle text-xs font-medium"
              }
            >
              <span
                className={
                  r.status === "online"
                    ? "w-1.5 h-1.5 rounded-full bg-success"
                    : "w-1.5 h-1.5 rounded-full bg-fg-subtle"
                }
              />
              {r.status}
            </span>
          );
        },
      },
      {
        id: "agents",
        accessorFn: (r) => r.agents.map((a) => a.id).join(", "),
        header: "Agents detected",
        cell: ({ row }) => (
          <span className="font-mono text-xs text-fg-muted">
            {row.original.agents.length === 0 ? "—" : row.original.agents.map((a) => a.id).join(", ")}
          </span>
        ),
      },
      {
        id: "heartbeat",
        accessorFn: (r) => r.last_heartbeat ?? 0,
        header: "Heartbeat",
        cell: ({ row }) => (
          <span className="text-fg-muted text-xs">
            {row.original.last_heartbeat ? formatHeartbeat(row.original.last_heartbeat) : "—"}
          </span>
        ),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => (
          <RowActionsMenu
            label={`Actions for ${row.original.hostname}`}
            actions={[
              {
                label: "Revoke",
                icon: <XCircleIcon className="size-4" />,
                destructive: true,
                onSelect: () => {
                  void remove(row.original.id);
                },
              },
            ]}
          />
        ),
        enableHiding: false,
        size: 56,
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const statusDisplay =
    status === "any" ? undefined : STATUS_OPTIONS.find((o) => o.value === status)?.label;

  const filters = (
    <FilterChip
      label="Status"
      active={status !== "any"}
      display={statusDisplay}
      onClear={() => setStatus("any")}
    >
      <PopoverContent
        align="start"
        sideOffset={4}
        collisionPadding={8}
        className="w-48 p-0"
      >
        <FacetedFilter
          options={STATUS_OPTIONS}
          value={status}
          onValueChange={(v) => setStatus(v as StatusValue)}
          searchPlaceholder="Status..."
        />
      </PopoverContent>
    </FilterChip>
  );

  return (
    <div role="main" aria-label="Sandbox Runtime" className="-m-3 p-4 space-y-10">
      {/* Section 1: System Providers */}
      <section role="region" aria-label="System Providers">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-fg">System Providers</h2>
            <p className="text-sm text-fg-subtle mt-0.5">
              Sandbox providers available on this host
            </p>
          </div>
        </div>

        {providersLoading && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)}
          </div>
        )}

        {providersError && (
          <div className="rounded-lg border border-border bg-bg-surface p-4 text-sm text-fg-muted">
            Failed to load providers: {providersError}
          </div>
        )}

        {!providersLoading && !providersError && providers.length === 0 && (
          <div className="rounded-lg border border-border bg-bg-surface p-4 text-sm text-fg-muted">
            No sandbox providers configured on this host.
          </div>
        )}

        {!providersLoading && !providersError && providers.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {providers.map((p) => <ProviderCard key={p.id} p={p} onSetup={setSetupProvider} />)}
          </div>
        )}
      </section>

      {/* System Providers: registration help */}
      <details className="rounded-lg border border-border bg-bg-surface/50">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-fg select-none hover:text-fg">
          How to enable additional sandbox providers
        </summary>
        <div className="px-4 pb-4 space-y-3 text-sm text-fg-muted">
          <p>
            System providers are seeded from environment variables at startup. Set the
            corresponding env var on the host and restart to enable the provider:
          </p>
          <div className="bg-bg border border-border rounded-lg p-3 font-mono text-xs space-y-1">
            {SYSTEM_PROVIDER_ENVS.map(({ env, label }) => (
              <div key={env}>
                <span className="text-fg">{env}</span>
                <span className="text-fg-subtle ml-2">— {label}</span>
              </div>
            ))}
          </div>
          <p>
            For BYOK (bring-your-own-key) providers, register via the API:
          </p>
          <div className="bg-bg border border-border rounded-lg p-3 font-mono text-xs whitespace-pre">
            <div className="text-fg select-all">{"curl -X POST /v1/sandbox_providers \\\n  -H \"x-api-key: $KEY\" \\\n  -d '{\"name\":\"My K8s\",\"type\":\"k8s\",\"config\":{\"base_url\":\"https://...\"}}'"}</div>
          </div>
          <p className="text-xs text-fg-subtle">
            The full provider API is documented at{" "}
            <a href="https://docs.oma.duyet.net/build/sandbox-providers" target="_blank" rel="noreferrer" className="underline hover:text-fg">
              docs.oma.duyet.net/build/sandbox-providers
            </a>
            .
          </p>
        </div>
      </details>

      {/* Section 2: Custom Runtimes */}
      <section role="region" aria-label="Custom Runtimes">
        <div className="mb-4 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-fg">Custom Runtimes</h2>
            <p className="text-sm text-fg-subtle mt-0.5">
              User-registered machines running <code className="text-xs bg-bg-surface px-1 py-0.5 rounded font-mono">oma bridge daemon</code>
            </p>
          </div>
        </div>

        {/* Install CLI card */}
        <div className="mb-4 rounded-lg border border-border bg-bg-surface px-4 py-3 flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-fg">Install the CLI</div>
            <div className="text-xs text-fg-subtle mt-0.5">
              The <code className="bg-bg px-1 rounded font-mono">oma</code> CLI lets you connect machines, manage agents, and
              configure integrations from the terminal.
            </div>
          </div>
          <code className="shrink-0 bg-bg border border-border rounded-md px-3 py-1.5 font-mono text-xs text-fg select-all">
            npm install -g @duyet/oma-cli
          </code>
        </div>

        <DataTable<Runtime>
          createLabel="+ Connect machine"
          onCreate={() => setShowInstructions(true)}
          filters={filters}
          data={filtered}
          loading={loading}
          getRowId={(r) => r.id}
          emptyTitle={status === "any" ? "No runtimes connected" : "No matching runtimes"}
          emptyKind="runtime"
          emptySubtitle={
            status === "any" ? (
              <>
                A runtime lets an agent's loop run on a machine you own instead of the cloud. Run{" "}
                <code className="text-xs bg-bg-surface px-1 py-0.5 rounded">npx @duyet/oma-cli bridge setup</code> on the machine you want to connect.
              </>
            ) : (
              "Try a different status filter."
            )
          }
          columns={columns}
        >
          <Modal
            open={showInstructions}
            onClose={() => setShowInstructions(false)}
            title="Connect a local machine"
            footer={<Button onClick={() => setShowInstructions(false)}>Done</Button>}
          >
            <div className="space-y-4 text-sm">
              <p className="text-fg-muted">
                On the machine you want to connect, run:
              </p>
              <div className="bg-bg-surface border border-border rounded-lg p-3 font-mono text-xs space-y-1">
                <div className="text-fg select-all">npx @duyet/oma-cli bridge setup</div>
              </div>
              <p className="text-fg-muted text-xs">
                Setup opens this browser for OAuth, writes credentials to{" "}
                <code className="bg-bg-surface px-1 rounded">~/.oma/bridge/</code>, and (on macOS) installs a launchd job
                that keeps the daemon running across reboots. The daemon scans your <code className="bg-bg-surface px-1 rounded">$PATH</code> for
                ACP-compatible agents and reports them here.
              </p>
              <div>
                <p className="text-fg-muted text-xs mb-1.5">
                  <strong>★ Featured agents</strong> — OMA's recommended set:
                </p>
                <ul className="text-xs text-fg-muted space-y-1 ml-4 list-disc font-mono">
                  <li><span className="text-fg">claude-acp</span> · <code className="bg-bg-surface px-1 rounded">npx -y @agentclientprotocol/claude-agent-acp</code> (auto-installed if <code className="bg-bg-surface px-1 rounded">claude</code> is on PATH)</li>
                  <li><span className="text-fg">codex-acp</span> · download from <a href="https://github.com/zed-industries/codex-acp/releases" target="_blank" rel="noreferrer" className="underline">zed-industries/codex-acp releases</a></li>
                  <li><span className="text-fg">openclaw</span> · <code className="bg-bg-surface px-1 rounded">npm i -g openclaw</code> (uses <code className="bg-bg-surface px-1 rounded">openclaw acp</code> bridge)</li>
                  <li><span className="text-fg">hermes</span> · <code className="bg-bg-surface px-1 rounded">curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash</code></li>
                </ul>
              </div>
              <div>
                <p className="text-fg-muted text-xs mb-1.5">
                  Setup auto-installs an ACP wrapper when an upstream binary is on <code className="bg-bg-surface px-1 rounded">$PATH</code>:
                </p>
                <ul className="text-xs text-fg-muted space-y-1 ml-4 list-disc">
                  <li><code className="bg-bg-surface px-1 rounded">claude</code> → installs <code className="bg-bg-surface px-1 rounded">@agentclientprotocol/claude-agent-acp</code></li>
                  <li><code className="bg-bg-surface px-1 rounded">codex</code> → installs <code className="bg-bg-surface px-1 rounded">@normahq/codex-acp-bridge</code> (drives codex over ACP)</li>
                  <li><code className="bg-bg-surface px-1 rounded">gemini</code> missing → installs <code className="bg-bg-surface px-1 rounded">@google/gemini-cli</code> (ships ACP natively)</li>
                </ul>
              </div>
              <p className="text-fg-muted text-xs">
                30+ other agents (gemini, opencode, cline, cursor, kimi, qwen-code, …) come from the
                <a href="https://agentclientprotocol.com/get-started/registry" target="_blank" rel="noreferrer" className="underline hover:text-fg ml-1">
                  official ACP Registry
                </a> — daemon fetches the manifest at startup and any installed binary becomes selectable.
              </p>
            </div>
          </Modal>
        </DataTable>
      </section>

      {/* Set-up dialog for a not-configured provider (e.g. Local subprocess) */}
      <Modal
        open={setupProvider !== null}
        onClose={() => setSetupProvider(null)}
        title={`Set up ${setupProvider?.label ?? "provider"}`}
        subtitle="Run this on the machine you want to connect."
        footer={<Button onClick={() => setSetupProvider(null)}>Done</Button>}
      >
        <div className="space-y-4 text-sm">
          <p className="text-fg-muted">
            Connect this host's local runtime by starting the bridge daemon:
          </p>
          <div className="bg-bg-surface border border-border rounded-lg p-3 font-mono text-xs space-y-1">
            <div className="text-fg select-all">npx @duyet/oma-cli bridge setup</div>
          </div>
          <p className="text-fg-muted text-xs">
            Setup opens this browser for OAuth, writes credentials to{" "}
            <code className="bg-bg-surface px-1 rounded">~/.oma/bridge/</code>, and (on macOS) installs a launchd job
            that keeps the daemon running across reboots. Once connected, this provider flips to{" "}
            <span className="text-success">Healthy</span> and any ACP agents on <code className="bg-bg-surface px-1 rounded">$PATH</code> appear under
            Custom Runtimes.
          </p>
        </div>
      </Modal>
    </div>
  );
}
