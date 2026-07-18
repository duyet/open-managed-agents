// Auto-generates a short, human-readable session title from the first
// user.message on a session whose `title` field is still empty.
//
// Extracted from session-do.ts so the summarize/fallback logic is
// unit-testable without a Durable Object — mirrors notify-dispatch.ts.
// session-do.ts calls generateSessionTitle fire-and-forget right after the
// first turn starts; it must never throw back into the caller and must
// never block the turn (see the try/catch + `void` call site).

import { generateText, type LanguageModel } from "ai";

const MAX_TITLE_LENGTH = 60;
const HEURISTIC_WORD_COUNT = 6;

/**
 * Heuristic fallback: first ~6 words of the message, whitespace collapsed
 * (no newlines), truncated to MAX_TITLE_LENGTH chars. Used when no
 * aux_model is configured, or the aux model call fails, times out, or
 * returns an empty string.
 */
export function heuristicTitle(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return "New session";
  const words = collapsed.split(" ").slice(0, HEURISTIC_WORD_COUNT).join(" ");
  return truncateTitle(words);
}

function truncateTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length <= MAX_TITLE_LENGTH) return trimmed;
  return trimmed.slice(0, MAX_TITLE_LENGTH - 1).trimEnd() + "…";
}

/**
 * Decides whether session-do.ts should kick off title generation for this
 * turn. Pure so the "runs once" guard is unit-testable without a Durable
 * Object: false once `currentTitle` is non-empty (title generation already
 * ran, or the caller supplied one at session-create), false for the
 * synthetic-empty-message resumes (tool confirmation / custom tool result
 * continuations use `skipAppend: true` and carry no real user text), and
 * false for a message with no extractable text.
 */
export function shouldGenerateSessionTitle(opts: {
  currentTitle: string;
  skipAppend: boolean;
  text: string;
}): boolean {
  if (opts.currentTitle) return false;
  if (opts.skipAppend) return false;
  return opts.text.trim().length > 0;
}

/**
 * Generate a session title from the first user message's text. Prefers the
 * agent's aux model (when configured) with a tight summarization prompt;
 * falls back to `heuristicTitle` on a missing aux model, any aux-model
 * error, timeout, or an empty/whitespace-only response. Never throws.
 */
export async function generateSessionTitle(opts: {
  text: string;
  auxModel: LanguageModel | null | undefined;
  /** Injectable for tests — defaults to the `ai` package's generateText. */
  generateTextFn?: typeof generateText;
}): Promise<string> {
  const fallback = heuristicTitle(opts.text);
  if (!opts.auxModel) return fallback;

  const gen = opts.generateTextFn ?? generateText;
  try {
    const result = await gen({
      model: opts.auxModel,
      prompt: `Summarize as a 3-6 word title, no quotes: ${opts.text.slice(0, 4000)}`,
      maxOutputTokens: 30,
      temperature: 0.3,
      abortSignal: AbortSignal.timeout(15_000),
    });
    const text = (result.text || "").trim().replace(/^["']|["']$/g, "");
    if (!text) return fallback;
    return truncateTitle(text.replace(/\s+/g, " "));
  } catch {
    return fallback;
  }
}
