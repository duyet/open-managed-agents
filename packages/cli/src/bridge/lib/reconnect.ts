/**
 * Reconnect backoff math for the daemon's WS attach loop.
 *
 * Kept as a pure module (no timers, no sockets) so the schedule is
 * unit-testable in the workers pool without spinning up a real
 * WebSocket. `daemon.ts` owns the actual `setTimeout`.
 *
 * We use *equal jitter* (a.k.a. "half + random half"): the delay is
 * `base/2 + rand(0, base/2)`, where `base` is the classic
 * `min(cap, min * 2^attempt)` exponential curve. Full jitter (pure
 * `rand(0, base)`) can occasionally reconnect near-instantly, which is
 * wasteful when the server is genuinely down; equal jitter keeps a
 * sensible floor while still spreading a herd of daemons out over the
 * window so a control-plane restart doesn't get a synchronized thundering
 * reconnect from every paired machine at once.
 */

export interface BackoffOptions {
  /** Floor for the exponential base, in ms. */
  minMs: number;
  /** Ceiling for the exponential base, in ms. */
  maxMs: number;
  /** Injectable RNG (0..1). Defaults to Math.random; override in tests. */
  rng?: () => number;
}

/**
 * Compute the next reconnect delay given the previous *base* (undecorated,
 * pre-jitter) delay. Returns both the jittered delay to actually sleep and
 * the next base to feed back in on the following failure.
 *
 * Seed the loop with `prevBaseMs = 0` (or `minMs`) on the first failure;
 * the base is clamped up to `minMs` internally so a 0 seed still produces
 * a sane first delay.
 */
export function nextBackoff(
  prevBaseMs: number,
  opts: BackoffOptions,
): { delayMs: number; baseMs: number } {
  const rng = opts.rng ?? Math.random;
  // Grow the base: double the previous, clamped into [minMs, maxMs].
  const grown = prevBaseMs <= 0 ? opts.minMs : prevBaseMs * 2;
  const baseMs = Math.min(Math.max(grown, opts.minMs), opts.maxMs);
  // Equal jitter: half fixed, half random.
  const half = baseMs / 2;
  const delayMs = Math.round(half + rng() * half);
  return { delayMs, baseMs };
}
