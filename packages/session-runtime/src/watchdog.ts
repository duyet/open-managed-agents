// Turn watchdog (issue #135) — the backstop for never-resolving harness
// turns.
//
// The k8s CA-upload deadlock (#133/#134) exposed a fail-loud gap that is
// independent of any one adapter: when a tool execution or harness step
// never resolves — for any reason — the session stays `running` forever.
// No session.error, no timeout, no signal beyond silence.
//
// runWithTurnWatchdog races the harness turn against a configurable
// ceiling (OMA_TURN_TIMEOUT_MS, default 15 minutes). On expiry it throws
// TurnWatchdogTimeoutError so the platform's existing error path emits
// session.error and returns the session to idle. Notes:
//
//   - This is the BACKSTOP, not the primary error path — adapters should
//     still fail fast themselves (e.g. the setup-phase timeout from #134).
//   - Pauses for external input (custom tool result, tool confirmation)
//     END the harness turn — the session goes idle with a requires_action
//     stop_reason — so the watchdog never ticks while a session is
//     legitimately waiting on a human.
//   - A genuinely hung underlying promise stays hung; the race just
//     guarantees the *session* fails loudly and recovers. The zombie is
//     abandoned.
//   - The platform must NOT auto-retry a watchdog timeout: re-running a
//     hang burns another full ceiling per retry. Callers check
//     `err instanceof TurnWatchdogTimeoutError` and skip retry.

export const DEFAULT_TURN_TIMEOUT_MS = 15 * 60 * 1000;

/** Floor so a typo'd tiny value can't kill every turn instantly. */
const MIN_TURN_TIMEOUT_MS = 10_000;

export class TurnWatchdogTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(
      `Turn watchdog: harness turn exceeded ${Math.round(timeoutMs / 1000)}s without completing — ` +
        "forcing session.error and returning the session to idle. The underlying tool/model call " +
        "never resolved (see issue #135); send a new message to retry, or raise OMA_TURN_TIMEOUT_MS " +
        "if turns this long are expected.",
    );
    this.name = "TurnWatchdogTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Parse OMA_TURN_TIMEOUT_MS. Returns the ceiling in ms, or null when the
 * watchdog is explicitly disabled (`0` / negative / `"off"`). Unset or
 * unparseable values fall back to the 15-minute default (never fail a
 * boot over a typo — the watchdog is a safety net, not config surface).
 */
export function resolveTurnTimeoutMs(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null || raw.trim() === "") return DEFAULT_TURN_TIMEOUT_MS;
  if (raw.trim().toLowerCase() === "off") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_TURN_TIMEOUT_MS;
  if (n <= 0) return null;
  return Math.max(n, MIN_TURN_TIMEOUT_MS);
}

/**
 * Run `fn` with a watchdog ceiling. `timeoutMs: null` disables the
 * watchdog (plain passthrough). The timer is always cleared when `fn`
 * settles first, so a fast turn never leaves a dangling timeout.
 */
export async function runWithTurnWatchdog<T>(
  fn: () => Promise<T>,
  opts: { timeoutMs: number | null; onTimeout?: () => void },
): Promise<T> {
  if (opts.timeoutMs === null) return fn();
  const timeoutMs = opts.timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          try {
            opts.onTimeout?.();
          } catch {
            /* observer only — never mask the timeout itself */
          }
          reject(new TurnWatchdogTimeoutError(timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
