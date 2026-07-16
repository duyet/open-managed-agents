// Block Kit rendering for agent output posted back to a Slack thread.
//
// Pure functions — no I/O. The thread reporter (thread-reporter.ts) calls
// these to turn progress snapshots and final agent text into `blocks` arrays
// for `chat.postMessage` / `chat.update`.
//
// Two concerns live here:
//   1. Progressive status blocks — a compact "🤖 working… ✓ step ✗ step"
//      indicator that gets rewritten in place as sub-agents report in.
//   2. Final response blocks — a header + the agent's markdown, with long
//      output truncated behind a "see full response" link to the Console.

import type { SlackBlock } from "./api/client";

/** Slack hard-caps a single section's text at 3000 chars. Stay under it. */
export const SECTION_TEXT_LIMIT = 3000;

/** Truncate to `limit` chars on a word boundary, appending an ellipsis. */
export function truncate(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  const slice = text.slice(0, limit);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > limit * 0.6 ? slice.slice(0, lastSpace) : slice;
  return { text: `${cut.trimEnd()}…`, truncated: true };
}

function section(text: string): SlackBlock {
  return { type: "section", text: { type: "mrkdwn", text } };
}

function context(text: string): SlackBlock {
  return { type: "context", elements: [{ type: "mrkdwn", text }] };
}

/** A single step shown in the progress indicator. */
export interface ProgressStep {
  label: string;
  state: "running" | "done" | "failed";
}

const STEP_ICON: Record<ProgressStep["state"], string> = {
  running: ":hourglass_flowing_sand:",
  done: ":white_check_mark:",
  failed: ":x:",
};

export interface ProgressSnapshot {
  /** One-line headline, e.g. "Investigating API latency spike". */
  headline: string;
  /** Ordered sub-steps (sub-agent calls, tool runs) to show under the headline. */
  steps: ProgressStep[];
  /** When true, render as finished (no spinner) — used just before the final post. */
  done?: boolean;
}

/**
 * Render the live "thinking / working" indicator. This is the message that
 * gets `chat.update`d repeatedly, so it must stay small and deterministic.
 */
export function renderProgressBlocks(snapshot: ProgressSnapshot): SlackBlock[] {
  const spinner = snapshot.done ? ":robot_face:" : ":robot_face: :hourglass_flowing_sand:";
  const blocks: SlackBlock[] = [section(`${spinner} *${snapshot.headline}*`)];
  if (snapshot.steps.length > 0) {
    const lines = snapshot.steps
      .slice(0, 20)
      .map((s) => `${STEP_ICON[s.state]} ${s.label}`)
      .join("\n");
    blocks.push(context(lines));
  }
  return blocks;
}

/** Plain fallback text for the progress message (mobile push / a11y). */
export function renderProgressText(snapshot: ProgressSnapshot): string {
  const done = snapshot.steps.filter((s) => s.state === "done").length;
  return `${snapshot.headline} (${done}/${snapshot.steps.length} steps)`;
}

export interface FinalResponseInput {
  /** Agent display name shown in the header. */
  agentName?: string;
  /** The agent's final markdown response. */
  body: string;
  /** Optional deep link to the full session in Console. */
  sessionUrl?: string;
}

/**
 * Render the final agent response as Block Kit. Long bodies are truncated to
 * one section with a "see the full response" link when a `sessionUrl` is
 * available. Code fences in the body are preserved (Slack renders ``` blocks
 * in mrkdwn).
 */
export function renderFinalResponseBlocks(input: FinalResponseInput): SlackBlock[] {
  const header = `:robot_face: *${input.agentName ?? "OMA Agent"}*`;
  const { text, truncated } = truncate(input.body.trim(), SECTION_TEXT_LIMIT);
  const blocks: SlackBlock[] = [section(header), { type: "divider" }, section(text)];
  if (truncated) {
    const link = input.sessionUrl
      ? `_Response truncated._ <${input.sessionUrl}|See the full response →>`
      : "_Response truncated — see the Console for the full output._";
    blocks.push(context(link));
  } else if (input.sessionUrl) {
    blocks.push(context(`<${input.sessionUrl}|Open in Console →>`));
  }
  return blocks;
}

/** Plain fallback text for the final response message. */
export function renderFinalResponseText(input: FinalResponseInput): string {
  const { text } = truncate(input.body.trim(), 300);
  return text || "(no response)";
}

/**
 * Render a friendly error message when the session errors or times out.
 * Never leaks stack traces / credentials — just a short reason.
 */
export function renderErrorBlocks(reason: string, sessionUrl?: string): SlackBlock[] {
  const { text } = truncate(reason.trim() || "Something went wrong.", 500);
  const blocks: SlackBlock[] = [
    section(`:warning: *The agent couldn't finish this request.*\n${text}`),
  ];
  if (sessionUrl) blocks.push(context(`<${sessionUrl}|View details in Console →>`));
  return blocks;
}
