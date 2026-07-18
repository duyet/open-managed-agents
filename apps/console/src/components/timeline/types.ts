import type { Event } from "../../lib/events";

/**
 * Layout constants — kept here as the single source of truth so that
 * Tailwind utility classes (`w-64`, `w-20`) and pixel arithmetic
 * (`256 + chartPx + 80`) stay in sync. Change here, change both.
 */
export const LABEL_COL_W = 256; // === w-64
export const DURATION_COL_W = 80; // === w-20
export const SIDE_PANEL_W = 420;

/**
 * One row in the timeline waterfall. A span can be an instant marker
 * (durationMs === 0) or a paired range (start + end events). Rendering
 * consumes only this shape; deriveSpans converts raw event streams to
 * Span[].
 */
export interface Span {
  key: string;
  family: SpanFamily;
  label: string;
  detail?: string;
  /** ms since the first event */
  startMs: number;
  /** 0 for instants */
  durationMs: number;
  /** Optional: ms from this span's start to first-token (model spans only).
   *  Used to render a TTFT divider inside the bar. */
  ttftMs?: number;
  /** Source events that contributed to this span (1 for instants,
   *  2 for paired spans, possibly more for tool calls with streaming
   *  input chunks). Click-to-expand renders the raw JSON of these. */
  events: Event[];
}

export type SpanFamily =
  | "model"
  | "tool"
  | "mcp"
  | "custom_tool"
  | "user"
  | "agent"
  | "system"
  | "warn"
  | "error"
  | "schedule"     // schedule tool's "waiting for alarm" window (10s, 1h, …)
  | "wakeup"       // user.message synthesized by onScheduledWakeup
  | "compaction"   // span.compaction_summarize_*
  | "outcome"      // span.outcome_evaluation_*
  | "thread"       // sub-agent thread lifecycle / messages
  | "aux"          // aux.model_call (web_fetch summarizer etc.)
  | "thinking"     // agent.thinking marker
  | "marker";      // catch-all for unrecognized event types

export const FAMILY_DOT: Record<SpanFamily, string> = {
  model: "bg-info",
  tool: "bg-success",
  mcp: "bg-accent-violet",
  custom_tool: "bg-warning",
  user: "bg-brand",
  agent: "bg-fg-muted",
  system: "bg-fg-subtle",
  warn: "bg-warning",
  error: "bg-danger",
  schedule: "bg-info",
  wakeup: "bg-info",
  compaction: "bg-accent-violet/70",
  outcome: "bg-success/70",
  thread: "bg-fg-muted",
  aux: "bg-fg-subtle",
  thinking: "bg-fg-subtle",
  marker: "bg-fg-subtle",
};

export const FAMILY_BAR: Record<SpanFamily, string> = {
  model: "bg-info/70",
  tool: "bg-success/70",
  mcp: "bg-accent-violet/70",
  custom_tool: "bg-warning/70",
  user: "bg-brand/70",
  agent: "bg-fg-muted/70",
  system: "bg-fg-subtle/70",
  warn: "bg-warning/70",
  error: "bg-danger/70",
  schedule: "bg-info/40",
  wakeup: "bg-info/70",
  compaction: "bg-accent-violet/50",
  outcome: "bg-success/50",
  thread: "bg-fg-muted/50",
  aux: "bg-fg-subtle/70",
  thinking: "bg-fg-subtle/40",
  marker: "bg-fg-subtle/40",
};

/** Short, human-readable name for the event-kind chip in each span row's
 *  label column and in the color legend. Deliberately terse (fits a
 *  pill) — the full label text next to it carries the specifics. */
export const FAMILY_LABEL: Record<SpanFamily, string> = {
  model: "Model",
  tool: "Tool",
  mcp: "MCP",
  custom_tool: "Custom",
  user: "User",
  agent: "Agent",
  system: "System",
  warn: "Warning",
  error: "Error",
  schedule: "Wait",
  wakeup: "Wakeup",
  compaction: "Compact",
  outcome: "Outcome",
  thread: "Thread",
  aux: "Aux",
  thinking: "Thinking",
  marker: "Event",
};

/** Pill background+text classes for the event-kind chip. Families with a
 *  dedicated semantic color (success/danger/warning/info/violet/brand)
 *  use their `-subtle` background; families without one fall back to a
 *  neutral chip that still reads clearly against a turn card's tinted
 *  background. */
export const FAMILY_CHIP: Record<SpanFamily, string> = {
  model: "bg-info-subtle text-info",
  tool: "bg-success-subtle text-success",
  mcp: "bg-accent-violet-subtle text-accent-violet",
  custom_tool: "bg-warning-subtle text-warning",
  user: "bg-brand-subtle text-brand",
  agent: "bg-bg text-fg-muted",
  system: "bg-bg text-fg-subtle",
  warn: "bg-warning-subtle text-warning",
  error: "bg-danger-subtle text-danger",
  schedule: "bg-info-subtle text-info",
  wakeup: "bg-info-subtle text-info",
  compaction: "bg-accent-violet-subtle text-accent-violet",
  outcome: "bg-success-subtle text-success",
  thread: "bg-bg text-fg-muted",
  aux: "bg-bg text-fg-subtle",
  thinking: "bg-bg text-fg-subtle",
  marker: "bg-bg text-fg-subtle",
};

/** Canonical display order for the legend — most-common-first rather than
 *  the SpanFamily union's declaration order, so the legend reads like a
 *  narrative (who spoke, then what work happened) instead of an
 *  alphabetized dump. */
export const FAMILY_ORDER: SpanFamily[] = [
  "user",
  "agent",
  "thinking",
  "model",
  "tool",
  "mcp",
  "custom_tool",
  "wakeup",
  "schedule",
  "compaction",
  "outcome",
  "thread",
  "aux",
  "system",
  "warn",
  "error",
  "marker",
];

/**
 * A "turn" is the unit of agent work between a user trigger event
 * (user.message / user.tool_confirmation / user.custom_tool_result) and
 * the next session.status_idle / .status_terminated / .error. This is the
 * same definition the harness uses internally (see drainEventQueue in
 * apps/agent/src/runtime/session-do.ts) and matches Conversation view's
 * notion of a turn — so a Timeline burst card lines up 1:1 with a chat
 * exchange.
 */
export type TurnTriggerKind =
  | "user_message"
  | "wakeup"
  | "tool_confirmation"
  | "custom_tool_result"
  | "init";

export type TurnStatus = "completed" | "running" | "errored" | "terminated";

export interface Turn {
  id: string;
  triggerKind: TurnTriggerKind;
  trigger?: Event;
  /** Wall-clock ms epoch of the trigger (or first event for init turn). */
  triggerTs: number;
  /** Inclusive: trigger event + everything until the closing status event. */
  events: Event[];
  status: TurnStatus;
  /** Wall-clock ms epoch when the turn closed; undefined while still running. */
  endedAt?: number;
}

export const TRIGGER_LABEL: Record<TurnTriggerKind, string> = {
  user_message: "user message",
  wakeup: "scheduled wakeup",
  tool_confirmation: "tool confirmation",
  custom_tool_result: "custom tool result",
  init: "session init",
};

export const TRIGGER_DOT: Record<TurnTriggerKind, string> = {
  user_message: "bg-brand",
  wakeup: "bg-info",
  tool_confirmation: "bg-warning",
  custom_tool_result: "bg-warning",
  init: "bg-fg-subtle",
};

/** Pill background+text classes for the turn-header status badge. */
export const STATUS_BADGE: Record<TurnStatus, string> = {
  completed: "bg-success-subtle text-success",
  running: "bg-info-subtle text-info",
  errored: "bg-danger-subtle text-danger",
  terminated: "bg-danger-subtle text-danger",
};

/**
 * What's currently selected for the side detail panel. Lifted up to
 * TimelineView so a click in any TurnCard updates one shared panel.
 */
export interface TimelineSelection {
  spanKey: string;
  spanLabel: string;
  events: Event[];
}
