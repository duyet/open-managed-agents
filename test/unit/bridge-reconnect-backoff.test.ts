// @ts-nocheck
/**
 * Reconnect backoff schedule for the bridge daemon's WS attach loop.
 *
 * The daemon must not hammer a downed control plane, and a fleet of paired
 * machines must not reconnect in lockstep after a server restart. These
 * tests pin the two properties that guarantee both: monotonic exponential
 * growth of the *base* up to the cap, and equal-jitter spread on the
 * actual delay.
 */

import { describe, it, expect } from "vitest";
import { nextBackoff } from "../../packages/cli/src/bridge/lib/reconnect";

const OPTS = { minMs: 1000, maxMs: 60_000 };

describe("nextBackoff — exponential base with equal jitter", () => {
  it("first failure (seed 0) yields a base clamped up to minMs", () => {
    const { baseMs } = nextBackoff(0, { ...OPTS, rng: () => 0 });
    expect(baseMs).toBe(1000);
  });

  it("doubles the base each step until the cap", () => {
    const bases: number[] = [];
    let base = 0;
    for (let i = 0; i < 10; i++) {
      const r = nextBackoff(base, { ...OPTS, rng: () => 0 });
      base = r.baseMs;
      bases.push(base);
    }
    expect(bases.slice(0, 7)).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000]);
    // Once capped it stays capped.
    expect(bases.every((b) => b <= OPTS.maxMs)).toBe(true);
    expect(bases[bases.length - 1]).toBe(60000);
  });

  it("equal jitter keeps the delay in [base/2, base] regardless of rng", () => {
    for (const roll of [0, 0.5, 0.999999]) {
      const { delayMs, baseMs } = nextBackoff(4000, { ...OPTS, rng: () => roll });
      expect(delayMs).toBeGreaterThanOrEqual(baseMs / 2);
      expect(delayMs).toBeLessThanOrEqual(baseMs);
    }
  });

  it("rng=0 gives exactly the floor half; rng≈1 gives ~the full base", () => {
    // prev 4000 → base doubles to 8000; half=4000.
    expect(nextBackoff(4000, { ...OPTS, rng: () => 0 }).delayMs).toBe(4000);
    expect(nextBackoff(4000, { ...OPTS, rng: () => 1 }).delayMs).toBe(8000);
  });

  it("two daemons with different rng streams get different delays (no lockstep)", () => {
    const a = nextBackoff(16000, { ...OPTS, rng: () => 0.1 }).delayMs;
    const b = nextBackoff(16000, { ...OPTS, rng: () => 0.9 }).delayMs;
    expect(a).not.toBe(b);
  });
});
