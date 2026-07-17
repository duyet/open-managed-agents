// Turn watchdog unit tests (issue #135).
//
// Covers the two pure/near-pure pieces in isolation:
//   - resolveTurnTimeoutMs: env-string parsing, including the "off" /
//     non-positive disable path and the min-floor guard.
//   - runWithTurnWatchdog: the actual race — fast completion wins, a
//     hang past the ceiling throws TurnWatchdogTimeoutError, timers are
//     always cleared, and `timeoutMs: null` is a pure passthrough.
//
// Integration with SessionStateMachine.runHarnessTurn (does the machine
// actually end the turn + propagate the error on a stuck harness) is
// covered separately in machine.test.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  resolveTurnTimeoutMs,
  runWithTurnWatchdog,
  TurnWatchdogTimeoutError,
  DEFAULT_TURN_TIMEOUT_MS,
} from "../src/watchdog";

describe("resolveTurnTimeoutMs", () => {
  it("defaults to the 15-minute ceiling when unset/empty", () => {
    expect(resolveTurnTimeoutMs(undefined)).toBe(DEFAULT_TURN_TIMEOUT_MS);
    expect(resolveTurnTimeoutMs(null)).toBe(DEFAULT_TURN_TIMEOUT_MS);
    expect(resolveTurnTimeoutMs("")).toBe(DEFAULT_TURN_TIMEOUT_MS);
    expect(resolveTurnTimeoutMs("   ")).toBe(DEFAULT_TURN_TIMEOUT_MS);
  });

  it("disables the watchdog on 'off' (case-insensitive)", () => {
    expect(resolveTurnTimeoutMs("off")).toBeNull();
    expect(resolveTurnTimeoutMs("OFF")).toBeNull();
    expect(resolveTurnTimeoutMs("Off")).toBeNull();
  });

  it("disables the watchdog on zero or negative values", () => {
    expect(resolveTurnTimeoutMs("0")).toBeNull();
    expect(resolveTurnTimeoutMs("-1")).toBeNull();
    expect(resolveTurnTimeoutMs("-99999")).toBeNull();
  });

  it("parses a valid positive numeric string", () => {
    expect(resolveTurnTimeoutMs("60000")).toBe(60_000);
  });

  it("falls back to the default on unparseable input rather than failing boot", () => {
    expect(resolveTurnTimeoutMs("not-a-number")).toBe(DEFAULT_TURN_TIMEOUT_MS);
    expect(resolveTurnTimeoutMs("15min")).toBe(DEFAULT_TURN_TIMEOUT_MS);
  });

  it("floors a tiny positive value so a typo can't kill every turn instantly", () => {
    expect(resolveTurnTimeoutMs("1")).toBe(10_000);
    expect(resolveTurnTimeoutMs("5000")).toBe(10_000);
    expect(resolveTurnTimeoutMs("10000")).toBe(10_000);
  });
});

describe("runWithTurnWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves normally when fn finishes before the ceiling", async () => {
    const fn = () => Promise.resolve("done");
    const result = await runWithTurnWatchdog(fn, { timeoutMs: 1000 });
    expect(result).toBe("done");
  });

  it("propagates a normal rejection from fn without waiting for the timer", async () => {
    const fn = () => Promise.reject(new Error("boom"));
    await expect(runWithTurnWatchdog(fn, { timeoutMs: 1000 })).rejects.toThrow("boom");
  });

  it("throws TurnWatchdogTimeoutError when fn never resolves before the ceiling", async () => {
    const fn = () => new Promise<void>(() => {}); // never resolves — simulated hang
    const onTimeout = vi.fn();

    const promise = runWithTurnWatchdog(fn, { timeoutMs: 5000, onTimeout });
    // Attach the rejection assertion before advancing timers so the
    // rejection is observed (unhandled rejection warnings avoided).
    const assertion = expect(promise).rejects.toBeInstanceOf(TurnWatchdogTimeoutError);

    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("timeout error message reports the configured ceiling", async () => {
    const fn = () => new Promise<void>(() => {});
    const promise = runWithTurnWatchdog(fn, { timeoutMs: 30_000 });
    const assertion = expect(promise).rejects.toThrow(/30s/);
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });

  it("an onTimeout observer that throws never masks the timeout error itself", async () => {
    const fn = () => new Promise<void>(() => {});
    const onTimeout = () => {
      throw new Error("observer blew up");
    };
    const promise = runWithTurnWatchdog(fn, { timeoutMs: 1000, onTimeout });
    const assertion = expect(promise).rejects.toBeInstanceOf(TurnWatchdogTimeoutError);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it("timeoutMs: null is a pure passthrough — no timer, no race", async () => {
    const fn = () => new Promise<string>((resolve) => setTimeout(() => resolve("ok"), 20_000));
    const promise = runWithTurnWatchdog(fn, { timeoutMs: null });
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(promise).resolves.toBe("ok");
  });

  it("clears the timer on a fast success so it never fires late", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const fn = () => Promise.resolve(42);
    await runWithTurnWatchdog(fn, { timeoutMs: 5000 });
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
