/**
 * Column-placement logic for the Sessions Kanban board (issue #22).
 *
 * Deliberately derives placement from EXISTING session lifecycle state
 * only — session `status` (idle | running | rescheduling | terminated,
 * see AGENTS.md "Session Lifecycle") plus the most recent event's
 * `stop_reason` (see AGENTS.md "Event Types" — `session.status_idle`
 * carries `stop_reason: { type: "end_turn" | "requires_action" }`). No
 * new backend state is introduced.
 */

export type KanbanColumn = "queued" | "running" | "blocked" | "done";

export const KANBAN_COLUMNS: ReadonlyArray<{ id: KanbanColumn; label: string }> = [
  { id: "queued", label: "Queued" },
  { id: "running", label: "Running" },
  { id: "blocked", label: "Blocked" },
  { id: "done", label: "Done" },
];

/**
 * Minimal shape of a session's most recent event, as read from the
 * `/v1/sessions/:id/events?order=desc&limit=1` response — specifically
 * the INNER `data` payload (the wrapper is `{ seq, type, ts, data }`;
 * `stop_reason` lives on `data`, not the wrapper — see
 * apps/agent/src/runtime/session-do.ts's GET /events handler and how
 * SessionDetail.tsx unwraps `e.data` before use).
 */
export interface LastEventForKanban {
  type: string;
  stop_reason?: { type: string };
}

/**
 * Places a session into one of the 4 Kanban columns.
 *
 *   - `running`      → status === "running"
 *   - `terminated`   → done (terminal, nothing pending)
 *   - `rescheduling` → queued (container still provisioning; hasn't
 *                      actually started a turn yet — see AGENTS.md's
 *                      "rescheduled" lifecycle state)
 *   - `idle`         → ambiguous on its own (could be "never started"
 *                      or "finished a turn"), disambiguated via the
 *                      session's last event:
 *       - no events yet                                   → queued
 *       - last event is `session.status_idle` with
 *         `stop_reason.type === "requires_action"`        → blocked
 *       - otherwise (finished a turn, nothing pending)     → done
 *
 * `lastEvent` is `null` when the session genuinely has zero events (or
 * the last-event fetch resolved that way). Pass `undefined` while that
 * per-session fetch is still in flight — the board treats it the same
 * as `null` (renders "queued" optimistically) until the fetch settles,
 * rather than inventing a 5th "unknown" column.
 */
export function deriveKanbanColumn(
  status: string | undefined,
  lastEvent: LastEventForKanban | null | undefined,
): KanbanColumn {
  if (status === "running") return "running";
  if (status === "terminated") return "done";
  if (status === "rescheduling") return "queued";

  // status is "idle" (or unset, which the server treats as idle too).
  if (!lastEvent) return "queued";
  if (lastEvent.type === "session.status_idle" && lastEvent.stop_reason?.type === "requires_action") {
    return "blocked";
  }
  return "done";
}
