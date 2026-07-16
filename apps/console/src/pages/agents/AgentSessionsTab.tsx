import { useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { useInfiniteApiQuery } from "../../lib/useApiQuery";
import { DataTable, type ColumnDef } from "../../components/DataTable";
import { FilterBar } from "../../components/FilterBar";
import { formatCompact, formatRelative } from "../../lib/format";
import { useAgentHub } from "../AgentDetail";
import type { SessionRecord as Session } from "../../types/session";

type StatusValue = "any" | "idle" | "running" | "rescheduling" | "terminated";

const STATUS_OPTIONS: { value: StatusValue; label: string }[] = [
  { value: "any", label: "All" },
  { value: "idle", label: "Idle" },
  { value: "running", label: "Running" },
  { value: "rescheduling", label: "Rescheduling" },
  { value: "terminated", label: "Terminated" },
];

const statusCls = (status?: string) => {
  switch (status) {
    case "idle":
      return "bg-success-subtle text-success";
    case "running":
      return "bg-info-subtle text-info";
    default:
      return "bg-bg-surface text-fg-muted";
  }
};

/** "105k / 7.5k", or "-" when both token counts are absent. */
function formatTokenPair(input?: number | null, output?: number | null): string {
  if (input == null && output == null) return "-";
  const fmt = (v?: number | null) => (v == null ? "-" : formatCompact(v).toLowerCase());
  return `${fmt(input)} / ${fmt(output)}`;
}

/**
 * Tab 2 — the full session table scoped to this agent
 * (`GET /v1/sessions?agent_id=…`). Mirrors SessionsList's column/filter
 * patterns minus the create modal (session creation lives in the hub
 * header) and the Agent facet (fixed to this agent). Adds a Tokens in/out
 * column from the session row's `input_tokens`/`output_tokens`.
 */
export function AgentSessionsTab() {
  const { agent } = useAgentHub();
  const nav = useNavigate();

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusValue>("any");
  const [created, setCreated] = useState<{ after?: number; before?: number }>({});

  const params = useMemo(
    () => ({
      agent_id: agent.id,
      ...(status !== "any" ? { status } : {}),
      ...(search ? { q: search } : {}),
      ...(created.after !== undefined
        ? { created_after: new Date(created.after).toISOString() }
        : {}),
      ...(created.before !== undefined
        ? { created_before: new Date(created.before).toISOString() }
        : {}),
    }),
    [agent.id, status, search, created.after, created.before],
  );

  const { items, isLoading, error, hasMore, isLoadingMore, loadMore, refresh } =
    useInfiniteApiQuery<Session>("/v1/sessions", { limit: 20, params });

  const columns = useMemo<ColumnDef<Session>[]>(
    () => [
      {
        id: "name",
        accessorFn: (s) => s.title ?? "",
        header: "Name",
        cell: ({ row }) => (
          <span className="font-medium text-fg">{row.original.title || "Untitled"}</span>
        ),
        enableHiding: false,
      },
      {
        id: "status",
        accessorFn: (s) => s.status ?? "idle",
        header: "Status",
        cell: ({ row }) => (
          <span
            className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${statusCls(row.original.status)}`}
          >
            {row.original.status || "idle"}
          </span>
        ),
      },
      {
        id: "tokens",
        header: "Tokens in / out",
        cell: ({ row }) => (
          <span className="font-mono text-xs text-fg-muted tabular-nums">
            {formatTokenPair(row.original.input_tokens, row.original.output_tokens)}
          </span>
        ),
      },
      {
        id: "id",
        accessorKey: "id",
        header: "ID",
        cell: ({ row }) => (
          <span title={row.original.id} className="font-mono text-xs text-fg-muted">
            {row.original.id}
          </span>
        ),
      },
      {
        id: "created",
        accessorFn: (s) => s.created_at,
        header: "Created",
        cell: ({ row }) => (
          <span className="text-fg-subtle text-xs whitespace-nowrap">
            {formatRelative(Date.now() - new Date(row.original.created_at).getTime())}
          </span>
        ),
      },
    ],
    [],
  );

  const hasActiveFilter =
    !!search || status !== "any" || created.after !== undefined || created.before !== undefined;

  const filters = (
    <FilterBar
      status={{
        value: status,
        onChange: (v) => setStatus(v as StatusValue),
        options: STATUS_OPTIONS,
      }}
      created={{ value: created, onChange: setCreated }}
    />
  );

  return (
    <DataTable<Session>
      searchPlaceholder="Search sessions..."
      searchValue={search}
      onSearchChange={setSearch}
      filters={filters}
      data={items}
      loading={isLoading}
      error={error}
      onRetry={refresh}
      errorTitle="Couldn't load sessions"
      getRowId={(s) => s.id}
      onRowClick={(s) => nav(`/sessions/${s.id}`)}
      hasMore={hasMore}
      loadingMore={isLoadingMore}
      onLoadMore={loadMore}
      emptyTitle={hasActiveFilter ? "No matching sessions" : "No sessions yet"}
      emptyKind="session"
      emptySubtitle={
        hasActiveFilter
          ? "Try different filters."
          : "Sessions created from this agent will show up here."
      }
      columns={columns}
    />
  );
}
