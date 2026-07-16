import { describe, it, expect } from "vitest";
import { mintOAuthState, verifyOAuthState } from "./oauth-state";

const SECRET = "test-oauth-state-secret";

describe("oauth-state", () => {
  it("round-trips a minted state", async () => {
    const state = await mintOAuthState(SECRET, {
      provider: "linear",
      userId: "user_1",
      tenantId: "tenant_1",
      returnUrl: "/integrations/linear",
    });
    const res = await verifyOAuthState(SECRET, state);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.payload.provider).toBe("linear");
    expect(res.payload.tenantId).toBe("tenant_1");
    expect(res.payload.returnUrl).toBe("/integrations/linear");
    expect(res.payload.nonce).toBeTruthy();
    expect(res.payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("mints a fresh CSRF nonce each time (not deterministic)", async () => {
    const a = await mintOAuthState(SECRET, { provider: "slack",
      userId: "user_1", tenantId: "t", returnUrl: "/x" });
    const b = await mintOAuthState(SECRET, { provider: "slack",
      userId: "user_1", tenantId: "t", returnUrl: "/x" });
    expect(a).not.toBe(b);
  });

  it("rejects a tampered payload (bad_signature)", async () => {
    const state = await mintOAuthState(SECRET, {
      provider: "github",
      userId: "user_1",
      tenantId: "tenant_1",
      returnUrl: "/x",
    });
    const [payload, sig] = state.split(".");
    // Flip a character in the payload without re-signing.
    const forged = `${payload.slice(0, -1)}${payload.endsWith("A") ? "B" : "A"}.${sig}`;
    const res = await verifyOAuthState(SECRET, forged);
    expect(res).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a state signed with a different secret", async () => {
    const state = await mintOAuthState(SECRET, { provider: "linear",
      userId: "user_1", tenantId: "t", returnUrl: "/x" });
    const res = await verifyOAuthState("other-secret", state);
    expect(res).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects an expired state", async () => {
    const state = await mintOAuthState(SECRET, {
      provider: "linear",
      userId: "user_1",
      tenantId: "t",
      returnUrl: "/x",
      ttlSeconds: -1,
    });
    const res = await verifyOAuthState(SECRET, state);
    expect(res).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects malformed input", async () => {
    expect(await verifyOAuthState(SECRET, "")).toEqual({ ok: false, reason: "malformed" });
    expect(await verifyOAuthState(SECRET, "no-dot")).toEqual({ ok: false, reason: "malformed" });
    expect((await verifyOAuthState(SECRET, "a.b")).ok).toBe(false);
  });
});
