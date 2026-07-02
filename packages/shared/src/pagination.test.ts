// Coverage for the cursor-pagination primitives shared across every
// *-store package. These have no test today even though every list
// route (agents, sessions, vaults, dreams, ...) depends on clampLimit +
// encodeCursor/decodeCursor behaving correctly for malformed input.

import { describe, it, expect } from "vitest";
import { clampLimit, encodeCursor, decodeCursor, toCursorPage, trimPage, fetchN } from "./pagination";

describe("clampLimit", () => {
  it("defaults to 50 when undefined", () => {
    expect(clampLimit(undefined)).toBe(50);
  });

  it("defaults to 50 for NaN — guards against ?limit=<non-numeric> route input", () => {
    expect(clampLimit(Number("not-a-number"))).toBe(50);
  });

  it("defaults to 50 for values below 1", () => {
    expect(clampLimit(0)).toBe(50);
    expect(clampLimit(-5)).toBe(50);
  });

  it("clamps to the max (default 200)", () => {
    expect(clampLimit(1000)).toBe(200);
  });

  it("clamps to a custom max", () => {
    expect(clampLimit(1000, 100)).toBe(100);
  });

  it("floors fractional values", () => {
    expect(clampLimit(10.9)).toBe(10);
  });

  it("passes through valid values unchanged", () => {
    expect(clampLimit(25)).toBe(25);
  });
});

describe("encodeCursor / decodeCursor", () => {
  it("round-trips a cursor", () => {
    const cursor = { createdAt: 1700000000000, id: "row_123" };
    const encoded = encodeCursor(cursor);
    expect(decodeCursor(encoded)).toEqual(cursor);
  });

  it("is base64url safe (no +, /, or = padding)", () => {
    const encoded = encodeCursor({ createdAt: 1700000000000, id: "id-with-special-chars-????" });
    expect(encoded).not.toMatch(/[+/=]/);
  });

  it("returns undefined for undefined input", () => {
    expect(decodeCursor(undefined)).toBeUndefined();
  });

  it("returns undefined for garbage input instead of throwing", () => {
    expect(decodeCursor("not-a-valid-cursor")).toBeUndefined();
  });

  it("returns undefined when the decoded shape is missing fields", () => {
    const badPayload = btoa(JSON.stringify({ t: 123 })); // missing `i`
    expect(decodeCursor(badPayload)).toBeUndefined();
  });
});

describe("trimPage / fetchN", () => {
  it("fetchN over-fetches by one to detect hasMore", () => {
    expect(fetchN(20)).toBe(21);
  });

  it("trims to limit and reports hasMore when the extra row was fetched", () => {
    const rows = [1, 2, 3];
    expect(trimPage(rows, 2)).toEqual({ items: [1, 2], hasMore: true });
  });

  it("reports hasMore=false when exactly limit rows come back", () => {
    const rows = [1, 2];
    expect(trimPage(rows, 2)).toEqual({ items: [1, 2], hasMore: false });
  });
});

describe("toCursorPage", () => {
  it("omits nextCursor when there is no more data", () => {
    const page = toCursorPage(
      { items: [{ createdAt: 1, id: "a" }], hasMore: false },
      (r) => r,
    );
    expect(page.nextCursor).toBeUndefined();
  });

  it("omits nextCursor for an empty page", () => {
    const page = toCursorPage({ items: [], hasMore: true }, (r: { createdAt: number; id: string }) => r);
    expect(page.nextCursor).toBeUndefined();
  });

  it("encodes nextCursor from the last item when hasMore is true", () => {
    const last = { createdAt: 42, id: "last" };
    const page = toCursorPage({ items: [{ createdAt: 1, id: "a" }, last], hasMore: true }, (r) => r);
    expect(page.nextCursor).toBe(encodeCursor(last));
  });
});
