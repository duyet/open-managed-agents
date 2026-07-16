// Unit tests for the oma#220 boot-secret gate.
//
// The "leaked" branch is exercised via the injectable `findLeaked` param
// rather than a real historically-leaked value — known-insecure-secrets.ts
// stores only SHA-256 digests specifically so that plaintext never
// re-appears in a fresh commit, and a test fixture would be exactly that.
import { describe, it, expect, vi, afterEach } from "vitest";
import type { Context } from "hono";
import { checkBootSecrets, createBootSecretGate } from "./boot-secrets";

const GOOD_ENV = {
  BETTER_AUTH_SECRET: "unit-test-auth-secret-not-a-real-value",
  PLATFORM_ROOT_SECRET: "unit-test-root-secret-not-a-real-value",
};

const noLeaks = async () => [];

describe("checkBootSecrets", () => {
  it("returns a clean verdict when both secrets are set and clean", async () => {
    expect(await checkBootSecrets(GOOD_ENV, noLeaks)).toEqual({ block: null, warn: null });
  });

  it("blocks on BETTER_AUTH_SECRET when missing", async () => {
    const verdict = await checkBootSecrets(
      { PLATFORM_ROOT_SECRET: GOOD_ENV.PLATFORM_ROOT_SECRET },
      noLeaks,
    );
    expect(verdict.block).toMatch(/BETTER_AUTH_SECRET/);
    expect(verdict.block).toMatch(/not set/);
    expect(verdict.warn).toBeNull();
  });

  it("blocks on PLATFORM_ROOT_SECRET when missing", async () => {
    const verdict = await checkBootSecrets(
      { BETTER_AUTH_SECRET: GOOD_ENV.BETTER_AUTH_SECRET },
      noLeaks,
    );
    expect(verdict.block).toMatch(/PLATFORM_ROOT_SECRET/);
  });

  it("blocks on both when both are missing", async () => {
    const verdict = await checkBootSecrets({}, noLeaks);
    expect(verdict.block).toMatch(/BETTER_AUTH_SECRET/);
    expect(verdict.block).toMatch(/PLATFORM_ROOT_SECRET/);
  });

  it("treats an empty string the same as unset", async () => {
    const verdict = await checkBootSecrets(
      { BETTER_AUTH_SECRET: "", PLATFORM_ROOT_SECRET: GOOD_ENV.PLATFORM_ROOT_SECRET },
      noLeaks,
    );
    expect(verdict.block).toMatch(/BETTER_AUTH_SECRET/);
  });

  it("warns (not blocks) when findLeaked reports a hit", async () => {
    const verdict = await checkBootSecrets(GOOD_ENV, async () => ["BETTER_AUTH_SECRET"]);
    expect(verdict.block).toBeNull();
    expect(verdict.warn).toMatch(/BETTER_AUTH_SECRET/);
  });

  it("checks presence before leaks — missing blocks even if findLeaked would also fail", async () => {
    const verdict = await checkBootSecrets(
      { PLATFORM_ROOT_SECRET: GOOD_ENV.PLATFORM_ROOT_SECRET },
      async () => ["PLATFORM_ROOT_SECRET"],
    );
    expect(verdict.block).toMatch(/not set/);
    expect(verdict.warn).toBeNull();
  });
});

// ── Minimal fake Hono Context — just enough surface for the gate: reads
// `.env` once, calls `.json(body, status)` on failure. Avoids depending on
// the real app's shared miniflare bindings/module state so this test can't
// be order-coupled with any other test file.
function fakeContext(env: Record<string, string | undefined>): Context {
  return {
    env,
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { "content-type": "application/json" },
      }),
  } as unknown as Context;
}

describe("createBootSecretGate", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 503 and does not call next() when a secret is missing", async () => {
    const gate = createBootSecretGate();
    let nextCalled = false;
    const res = await gate(fakeContext({}), async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(false);
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(503);
    const body = (await (res as Response).json()) as { error?: string };
    expect(body.error).toMatch(/BETTER_AUTH_SECRET/);
  });

  it("calls next() and returns nothing itself when both secrets are clean", async () => {
    const gate = createBootSecretGate();
    let nextCalled = false;
    const res = await gate(fakeContext(GOOD_ENV), async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    expect(res).toBeUndefined(); // gate itself returns nothing on the happy path
  });

  it("serves traffic on a leaked secret but logs the operator error exactly once", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const gate = createBootSecretGate(async () => ["BETTER_AUTH_SECRET"]);

    let nextCalls = 0;
    await gate(fakeContext(GOOD_ENV), async () => {
      nextCalls += 1;
    });
    await gate(fakeContext(GOOD_ENV), async () => {
      nextCalls += 1;
    });

    expect(nextCalls).toBe(2); // never blocked
    expect(errorSpy).toHaveBeenCalledTimes(1); // nag once per isolate, not per request
    expect(String(errorSpy.mock.calls[0][0])).toMatch(/BETTER_AUTH_SECRET/);
  });

  it("memoizes the first verdict — a later request on the same instance stays gated", async () => {
    const gate = createBootSecretGate();

    // First call: bad env → 503.
    const first = (await gate(fakeContext({}), async () => {})) as Response;
    expect(first.status).toBe(503);

    // Second call on the SAME gate instance, now with a clean env — should
    // still be gated, because the verdict is memoized per-isolate (mirrors
    // the real app: secrets don't change mid-isolate-lifetime).
    let nextCalled = false;
    const second = (await gate(fakeContext(GOOD_ENV), async () => {
      nextCalled = true;
    })) as Response;
    expect(second.status).toBe(503);
    expect(nextCalled).toBe(false);
  });

  it("a fresh gate instance re-evaluates independently of other instances", async () => {
    const badGate = createBootSecretGate();
    await badGate(fakeContext({}), async () => {});

    const freshGate = createBootSecretGate();
    let nextCalled = false;
    await freshGate(fakeContext(GOOD_ENV), async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });
});
