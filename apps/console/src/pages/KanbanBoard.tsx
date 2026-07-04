import { useMemo } from "react";
import { useNavigate } from "react-router";
import { useQueries } from "@tanstack/react-query";
import { useApi } from "../lib/api";
import { useApiQuery, buildUrl } from "../lib/useApiQuery";
import { EmptyState } from "../components/EmptyState";
import { Skeleton } from "../components/Skeleton";
import { formatRelative, shortenId } from "../lib/format";
import {
  deriveKanbanColumn,
  KANBAN_COLUMNS,
  type KanbanColumn,
  type LastEventForKanban,
} from "../lib/kanban";
import type { SessionRecord } from "../types/session";

// No board-wide SSE endpoint exists — SessionDetail's live stream
// (lib/sse.ts streamSse / useApi().streamEvents) is scoped to a single
// session, and opening one connection per visible card doesn't scale.
// A poll is the same auto-refresh mechanism RuntimesList uses for its
// 15s heartbeat — see apps/console/src/pages/RuntimesList.tsx.
const POLL_MS = 15_000;

// Practical cap for a board view — a Kanban board is meant to be
// glanceable, not paginated. If a tenant runs more than this many
// concurrent/recent sessions, only the most recent ones show up here;
// the full list at /sessions still supports proper pagination.
const BOARD_LIMIT = "100";

/** Wire shape of one row from GET /:id/events — the wrapper carries
 *  seq/type/ts; the actual event (stop_reason etc.) lives under `data`.
 *  See lib/kanban.ts's LastEventForKanban doc comment. */
interface EventRow {
  type: string;
  data: LastEventForKanban;
}

interface LastEventsResponse {
  data: EventRow[];
}

export function KanbanBoard() {
  const nav = useNavigate();
  const { api } = useApi();

  const { data: sessionsRes, isLoading } = useApiQuery<{ data: SessionRecord[] }>(
    "/v1/sessions",
    { limit: BOARD_LIMIT },
    { refetchInterval: POLL_MS },
  );
  const sessions = useMemo(() => sessionsRes?.data ?? [], [sessionsRes]);

  // "running" and "terminated" are unambiguous from `status` alone.
  // "idle" is not — it covers both "never started" (queued) and
  // "finished a turn" (blocked or done), so we fetch each idle
  // session's last event to disambiguate. See deriveKanbanColumn.
  const idleSessionIds = useMemo(
    () => sessions.filter((s) => (s.status ?? "idle") === "idle").map((s) => s.id),
    [sessions],
  );

  const lastEventQueries = useQueries({
    queries: idleSessionIds.map((id) => ({
      queryKey: ["kanban-last-event", id],
      queryFn: () =>
        api<LastEventsResponse>(
          buildUrl(`/v1/sessions/${id}/events`, { order: "desc", limit: "1" }),
        ),
      refetchInterval: POLL_MS,
      staleTime: POLL_MS,
    })),
  });

  const lastEventBySessionId = useMemo(() => {
    const map = new Map<string, LastEventForKanban | null | undefined>();
    idleSessionIds.forEach((id, i) => {
      const query = lastEventQueries[i];
      if (query?.data === undefined) {
        // Fetch hasn't resolved yet — deriveKanbanColumn treats this the
        // same as "no events" (renders queued optimistically).
        map.set(id, undefined);
        return;
      }
      // Resolved: `data.data` is the events array; empty means the
      // session genuinely has zero events yet (null, not undefined).
      const row = query.data.data[0];
      map.set(id, row ? row.data : null);
    });
    return map;
  }, [idleSessionIds, lastEventQueries]);

  const columns = useMemo(() => {
    const grouped: Record<KanbanColumn, SessionRecord[]> = {
      queued: [],
      running: [],
      blocked: [],
      done: [],
    };
    for (const s of sessions) {
      const col = deriveKanbanColumn(s.status, lastEventBySessionId.get(s.id));
      grouped[col].push(s);
    }
    return grouped;
  }, [sessions, lastEventBySessionId]);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="pl-3 pr-4 py-6 space-y-6">
        <header>
          <h1 className="font-display text-[32px] leading-tight font-semibold tracking-tight text-fg">
            Kanban Board
          </h1>
          <p className="mt-1.5 text-[15px] text-fg-muted">
            Sessions grouped by queued, running, blocked, and done — derived from session status
            and the last event's stop reason.
          </p>
        </header>

        {isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {KANBAN_COLUMNS.map((c) => (
              <div key={c.id} className="space-y-2">
                <Skeleton className="h-5 w-24" />
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-20 w-full" />
              </div>
            ))}
          </div>
        ) : sessions.length === 0 ? (
          <EmptyState
            title="No sessions yet"
            body="Sessions will appear here once created through the API."
            kind="session"
            size="lg"
          />
        ) : (
          <div
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4"
            data-testid="kanban-board"
          >
            {KANBAN_COLUMNS.map((col) => (
              <div key={col.id} className="flex flex-col gap-2 min-w-0" data-testid={`kanban-column-${col.id}`}>
                <div className="flex items-center justify-between px-1">
                  <h2 className="text-sm font-medium text-fg">{col.label}</h2>
                  <span className="text-xs text-fg-subtle tabular-nums">
                    {columns[col.id].length}
                  </span>
                </div>
                <div className="flex flex-col gap-2">
                  {columns[col.id].length === 0 ? (
                    <div className="text-xs text-fg-subtle border border-dashed border-border rounded-lg px-3 py-4 text-center">
                      Empty
                    </div>
                  ) : (
                    columns[col.id].map((s) => (
                      <button
                        key={s.id}
                        onClick={() => nav(`/sessions/${s.id}`)}
                        className="text-left border border-border rounded-lg bg-bg-surface/40 hover:border-border-strong hover:bg-bg-surface px-3 py-2.5 transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
                      >
                        <div className="text-sm font-medium text-fg truncate">
                          {s.title?.trim() || "Untitled"}
                        </div>
                        <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-fg-subtle font-mono">
                          <span className="truncate">{shortenId(s.agent.id)}</span>
                          <span className="shrink-0">
                            {formatRelative(Date.now() - new Date(s.created_at).getTime())}
                          </span>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
