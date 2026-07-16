// Unit tests for the issue #222 fallback: resolveSessionMetadata /
// walletFromMetadata. No Durable Object needed — see the file-level comment
// in resolve-session-metadata.ts.

import { describe, expect, it, vi } from "vitest";
import { resolveSessionMetadata, walletFromMetadata } from "./resolve-session-metadata";

describe("resolveSessionMetadata", () => {
  it("returns the cached value as-is without a row lookup when defined", async () => {
    const lookupRow = vi.fn();
    const cached = { publication_id: "pub_1", end_user_id: "eu_1" };
    const result = await resolveSessionMetadata(cached, "t1", "sess_1", { lookupRow });
    expect(result).toBe(cached);
    expect(lookupRow).not.toHaveBeenCalled();
  });

  it("returns an empty cached object as-is without a row lookup (authoritative, just empty)", async () => {
    const lookupRow = vi.fn();
    const result = await resolveSessionMetadata({}, "t1", "sess_1", { lookupRow });
    expect(result).toEqual({});
    expect(lookupRow).not.toHaveBeenCalled();
  });

  it("falls back to the row lookup when cached is undefined (legacy session)", async () => {
    const lookupRow = vi.fn(async () => ({ publication_id: "pub_2", end_user_id: "eu_2" }));
    const result = await resolveSessionMetadata(undefined, "t1", "sess_2", { lookupRow });
    expect(result).toEqual({ publication_id: "pub_2", end_user_id: "eu_2" });
    expect(lookupRow).toHaveBeenCalledWith("t1", "sess_2");
  });

  it("falls back to {} when the row lookup finds no metadata (null)", async () => {
    const lookupRow = vi.fn(async () => null);
    const result = await resolveSessionMetadata(undefined, "t1", "sess_3", { lookupRow });
    expect(result).toEqual({});
  });
});

describe("walletFromMetadata", () => {
  it("returns the wallet identity when both ids are present", () => {
    expect(walletFromMetadata({ publication_id: "pub_1", end_user_id: "eu_1" })).toEqual({
      publication_id: "pub_1",
      end_user_id: "eu_1",
    });
  });

  it("coerces non-string ids to strings", () => {
    expect(walletFromMetadata({ publication_id: 123, end_user_id: 456 })).toEqual({
      publication_id: "123",
      end_user_id: "456",
    });
  });

  it("returns null when publication_id is missing", () => {
    expect(walletFromMetadata({ end_user_id: "eu_1" })).toBeNull();
  });

  it("returns null when end_user_id is missing", () => {
    expect(walletFromMetadata({ publication_id: "pub_1" })).toBeNull();
  });

  it("returns null for an empty metadata bag", () => {
    expect(walletFromMetadata({})).toBeNull();
  });

  it("returns null when a deployment_run/scheduled_run bag has no wallet ids", () => {
    // Deployment/schedule sessions carry different metadata shapes
    // (metadata.deployment_run.deployment_id / metadata.scheduled_run.schedule_id)
    // — neither is a public-consumer wallet, so this must resolve to null,
    // not throw or misinterpret nested keys.
    expect(walletFromMetadata({ deployment_run: { deployment_id: "dep_1" } })).toBeNull();
    expect(walletFromMetadata({ scheduled_run: { schedule_id: "sch_1" } })).toBeNull();
  });
});
