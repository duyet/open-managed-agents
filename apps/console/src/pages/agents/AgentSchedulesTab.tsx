import { useMemo, useState } from "react";
import { Link } from "react-router";
import { PlayIcon, TrashIcon } from "lucide-react";
import { toast } from "sonner";

import { useApi } from "../../lib/api";
import { useApiQuery } from "../../lib/useApiQuery";
import { DataTable, type ColumnDef } from "../../components/DataTable";
import { RowActionsMenu } from "../../components/RowActionsMenu";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/hooks/useConfirm";
import { formatRelative } from "../../lib/format";
import { useAgentHub } from "../AgentDetail";
import { CreateScheduleDialog } from "./CreateScheduleDialog";
import type { AgentSchedule } from "./schedule-types";

function lastRunCls(status: string | null | undefined) {
  if (status === "ok") return "text-success";
  if (status === "error" || status === "skipped_concurrency") return "text-danger";
  return "text-fg-subtle";
}

/**
 * Tab — cron schedules scoped to this agent (see AGENTS.md "Agent
 * Schedules"). Unlike deployments, the backend has no PATCH route, so
 * there's no enable/disable toggle here — only Run now and Delete.
 */
export function AgentSchedulesTab() {
  const { agent } = useAgentHub();
  const { api } = useApi();
  const [showCreate, setShowCreate] = useState(false);
  const confirm = useConfirm();

  const {
    data,
    isLoading,
    refetch,
  } = useApiQuery<{ data: AgentSchedule[] }>(`/v1/agents/${agent.id}/schedules`);
  const items = data?.data ?? [];

  const runNow = async (s: AgentSchedule) => {
    try {
      await api(`/v1/agents/${agent.id}/schedules/${s.id}/run`, { method: "POST" });
      toast.success("Queued — will fire on the next cron tick");
      refetch();
    } catch {
      // api() toasts the error.
    }
  };

  const del = async (s: AgentSchedule) => {
    if (
      !(await confirm({
        title: "Delete schedule?",
        description: `Cron "${s.cron_expression}" will stop firing. This can't be undone.`,
        confirmLabel: "Delete",
        destructive: true,
      }))
    )
      return;
    try {
      await api(`/v1/agents/${agent.id}/schedules/${s.id}`, { method: "DELETE" });
      refetch();
    } catch {
      // api() toasts the error.
    }
  };

  const columns = useMemo<ColumnDef<AgentSchedule>[]>(
    () => [
      {
        id: "cron",
        header: "Cron",
        cell: ({ row }) => (
          <span className="font-mono text-sm text-fg">{row.original.cron_expression}</span>
        ),
        enableHiding: false,
      },
      {
        id: "timezone",
        header: "Timezone",
        cell: ({ row }) => <span className="text-xs text-fg-muted">{row.original.timezone}</span>,
      },
      {
        id: "enabled",
        header: "Enabled",
        cell: ({ row }) => (
          <span
            className={
              "inline-flex items-center text-[11px] px-1.5 py-0.5 rounded " +
              (row.original.enabled
                ? "bg-success-subtle text-success"
                : "bg-bg-surface text-fg-muted")
            }
          >
            {row.original.enabled ? "Enabled" : "Disabled"}
          </span>
        ),
      },
      {
        id: "next_run",
        header: "Next run",
        cell: ({ row }) => {
          const t = row.original.next_run_at;
          if (!t) return <span className="text-fg-subtle text-xs">Never</span>;
          return (
            <span className="text-xs text-fg-muted">
              {formatRelative(new Date(t).getTime() - Date.now())}
            </span>
          );
        },
      },
      {
        id: "last_run",
        header: "Last run",
        cell: ({ row }) => {
          const s = row.original;
          if (!s.last_run_at) return <span className="text-fg-subtle text-xs">Never</span>;
          const rel = formatRelative(Date.now() - new Date(s.last_run_at).getTime());
          const label = (
            <span className={`text-xs ${lastRunCls(s.last_run_status)}`}>
              {s.last_run_status ?? "—"} · {rel}
            </span>
          );
          return s.last_session_id ? (
            <Link
              to={`/sessions/${s.last_session_id}`}
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
        id: "actions",
        header: "",
        cell: ({ row }) => {
          const s = row.original;
          return (
            <RowActionsMenu
              label={`Actions for schedule ${s.id}`}
              actions={[
                {
                  label: "Run now",
                  icon: <PlayIcon className="size-4" />,
                  onSelect: () => runNow(s),
                },
                {
                  label: "Delete",
                  icon: <TrashIcon className="size-4" />,
                  destructive: true,
                  onSelect: () => del(s),
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
    [api, agent.id],
  );

  return (
    <>
      <DataTable<AgentSchedule>
        createLabel="+ Create schedule"
        onCreate={() => setShowCreate(true)}
        data={items}
        loading={isLoading}
        getRowId={(s) => s.id}
        hasMore={false}
        loadingMore={false}
        onLoadMore={() => {}}
        emptyTitle="No schedules"
        emptySubtitle="Run this agent on a cron cadence — recurring maintenance, digests, or polling jobs."
        emptyAction={<Button onClick={() => setShowCreate(true)}>+ Create schedule</Button>}
        columns={columns}
      />

      <CreateScheduleDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        agent={agent}
        onCreated={() => {
          refetch();
        }}
      />
    </>
  );
}
