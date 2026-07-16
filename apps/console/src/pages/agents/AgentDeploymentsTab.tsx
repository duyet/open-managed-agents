import { useMemo, useState } from "react";
import { Link } from "react-router";
import { PlayIcon, PauseIcon, TrashIcon } from "lucide-react";
import { toast } from "sonner";

import { useApi } from "../../lib/api";
import { useInfiniteApiQuery } from "../../lib/useApiQuery";
import { DataTable, type ColumnDef } from "../../components/DataTable";
import { RowActionsMenu } from "../../components/RowActionsMenu";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/hooks/useConfirm";
import { formatRelative } from "../../lib/format";
import { cn } from "@/lib/utils";
import { useAgentHub } from "../AgentDetail";
import { CreateDeploymentDialog } from "./CreateDeploymentDialog";
import type { Deployment } from "./deployment-types";

/** Manual / Schedule / Webhook trigger badge. */
function TriggerBadge({ deployment }: { deployment: Deployment }) {
  const t = deployment.trigger;
  const base = "inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded";
  if (t?.type === "schedule") {
    return (
      <span className={`${base} bg-info-subtle text-info`} title={t.timezone ?? "UTC"}>
        <span className="font-mono">{t.cron_expression}</span>
      </span>
    );
  }
  if (t?.type === "webhook") {
    return <span className={`${base} bg-accent-violet-subtle text-accent-violet`}>Webhook</span>;
  }
  return <span className={`${base} bg-bg-surface text-fg-muted`}>Manual</span>;
}

function lastRunCls(status: string | null) {
  if (status === "ok") return "text-success";
  if (status === "error") return "text-danger";
  return "text-fg-subtle";
}

/**
 * Tab 3 — deployments scoped to this agent. Empty state prompts a first
 * deployment; the table lists trigger / enabled / last-run with Run now,
 * Enable/Disable, and Delete row actions.
 */
export function AgentDeploymentsTab() {
  const { agent, versions } = useAgentHub();
  const { api } = useApi();
  const [showCreate, setShowCreate] = useState(false);
  const confirm = useConfirm();

  const params = useMemo(() => ({ agent_id: agent.id }), [agent.id]);
  const { items, isLoading, hasMore, isLoadingMore, loadMore, refresh } =
    useInfiniteApiQuery<Deployment>("/v1/deployments", { limit: 20, params });

  const runNow = async (d: Deployment) => {
    try {
      const res = await api<{ session_id: string }>(`/v1/deployments/${d.id}/run`, {
        method: "POST",
        body: "{}",
      });
      toast.success("Run started", {
        action: {
          label: "View session",
          onClick: () => {
            window.location.href = `/sessions/${res.session_id}`;
          },
        },
      });
      refresh();
    } catch {
      // api() toasts the error.
    }
  };

  const toggleEnabled = async (d: Deployment) => {
    try {
      await api(`/v1/deployments/${d.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !d.enabled }),
      });
      refresh();
    } catch {
      /* toasted */
    }
  };

  const del = async (d: Deployment) => {
    if (
      !(await confirm({
        title: `Delete deployment "${d.name}"?`,
        description: "This can't be undone.",
        confirmLabel: "Delete",
        destructive: true,
      }))
    )
      return;
    try {
      await api(`/v1/deployments/${d.id}`, { method: "DELETE" });
      refresh();
    } catch {
      /* toasted */
    }
  };

  const columns = useMemo<ColumnDef<Deployment>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => <span className="font-medium text-fg">{row.original.name}</span>,
        enableHiding: false,
      },
      {
        id: "trigger",
        header: "Trigger",
        cell: ({ row }) => <TriggerBadge deployment={row.original} />,
      },
      {
        id: "enabled",
        header: "Enabled",
        cell: ({ row }) => (
          <span
            className={cn(
              "inline-flex items-center text-[11px] px-1.5 py-0.5 rounded",
              row.original.enabled
                ? "bg-success-subtle text-success"
                : "bg-bg-surface text-fg-muted",
            )}
          >
            {row.original.enabled ? "Enabled" : "Disabled"}
          </span>
        ),
      },
      {
        id: "last_run",
        header: "Last run",
        cell: ({ row }) => {
          const d = row.original;
          if (!d.last_run_at) return <span className="text-fg-subtle text-xs">Never</span>;
          const rel = formatRelative(Date.now() - new Date(d.last_run_at).getTime());
          const label = (
            <span className={`text-xs ${lastRunCls(d.last_run_status)}`}>
              {d.last_run_status ?? "—"} · {rel}
            </span>
          );
          return d.last_session_id ? (
            <Link
              to={`/sessions/${d.last_session_id}`}
              onClick={(e) => e.stopPropagation()}
              className="hover:underline"
            >
              {label}
            </Link>
          ) : (
            label
          );
        },
      },
      {
        id: "created",
        accessorKey: "created_at",
        header: "Created",
        cell: ({ row }) => (
          <span className="text-fg-subtle text-xs whitespace-nowrap">
            {formatRelative(Date.now() - new Date(row.original.created_at).getTime())}
          </span>
        ),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => {
          const d = row.original;
          return (
            <RowActionsMenu
              label={`Actions for ${d.name}`}
              actions={[
                {
                  label: "Run now",
                  icon: <PlayIcon className="size-4" />,
                  onSelect: () => runNow(d),
                },
                {
                  label: d.enabled ? "Disable" : "Enable",
                  icon: <PauseIcon className="size-4" />,
                  onSelect: () => toggleEnabled(d),
                },
                {
                  label: "Delete",
                  icon: <TrashIcon className="size-4" />,
                  destructive: true,
                  onSelect: () => del(d),
                },
              ]}
            />
          );
        },
        enableHiding: false,
        size: 56,
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, refresh],
  );

  return (
    <>
      <DataTable<Deployment>
        createLabel="+ Create deployment"
        onCreate={() => setShowCreate(true)}
        data={items}
        loading={isLoading}
        getRowId={(d) => d.id}
        hasMore={hasMore}
        loadingMore={isLoadingMore}
        onLoadMore={loadMore}
        emptyTitle="No deployments"
        emptySubtitle="Deploy this agent to run it on a schedule, via webhook, or manually."
        emptyAction={<Button onClick={() => setShowCreate(true)}>+ Create deployment</Button>}
        columns={columns}
      />

      <CreateDeploymentDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        agent={agent}
        versions={versions}
        onCreated={() => {
          refresh();
        }}
      />
    </>
  );
}
