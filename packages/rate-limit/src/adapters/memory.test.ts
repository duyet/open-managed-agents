// MemoryRateLimitGate is the token-bucket gate the Node self-host uses
// for /auth/* and /v1/* rate limiting. No prior test covered its actual
// bucket arithmetic (exhaustion, reset, cost > 1, retryAfter).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MemoryRateLimitGate, buildMemoryGates } from "./memory";

describe("MemoryRateLimitGate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows requests up to the point budget", async () => {
    const gate = new MemoryRateLimitGate(3, 60);
    expect((await gate.consume("k")).ok).toBe(true);
    expect((await gate.consume("k")).ok).toBe(true);
    expect((await gate.consume("k")).ok).toBe(true);
  });

  it("rejects once the budget is exhausted, with a retryAfter", async () => {
    const gate = new MemoryRateLimitGate(1, 60);
    expect((await gate.consume("k")).ok).toBe(true);
    const r = await gate.consume("k");
    expect(r.ok).toBe(false);
    expect(r.retryAfter).toBe(60);
  });

  it("tracks buckets independently per key", async () => {
    const gate = new MemoryRateLimitGate(1, 60);
    expect((await gate.consume("a")).ok).toBe(true);
    expect((await gate.consume("b")).ok).toBe(true);
    expect((await gate.consume("a")).ok).toBe(false);
  });

  it("respects a custom cost per consume() call", async () => {
    const gate = new MemoryRateLimitGate(5, 60);
    expect((await gate.consume("k", 3)).ok).toBe(true);
    expect((await gate.consume("k", 3)).ok).toBe(false); // only 2 left
    expect((await gate.consume("k", 2)).ok).toBe(true);
  });

  it("refills the bucket once the window elapses", async () => {
    const gate = new MemoryRateLimitGate(1, 60);
    expect((await gate.consume("k")).ok).toBe(true);
    expect((await gate.consume("k")).ok).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect((await gate.consume("k")).ok).toBe(true);
  });
});

describe("buildMemoryGates", () => {
  it("applies defaults when no overrides are passed", async () => {
    const gates = buildMemoryGates();
    // authSendEmail defaults to 3/min — 4th consume in the same window rejects.
    await gates.authSendEmail.consume("x");
    await gates.authSendEmail.consume("x");
    await gates.authSendEmail.consume("x");
    expect((await gates.authSendEmail.consume("x")).ok).toBe(false);
  });

  it("merges partial overrides with defaults", async () => {
    const gates = buildMemoryGates({ apiWrite: { points: 1, durationSec: 60 } });
    expect((await gates.apiWrite.consume("x")).ok).toBe(true);
    expect((await gates.apiWrite.consume("x")).ok).toBe(false);
    // untouched gate still uses its default budget (60/min)
    expect((await gates.authIp.consume("x")).ok).toBe(true);
  });
});
