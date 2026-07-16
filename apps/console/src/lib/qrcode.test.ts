import { describe, expect, it } from "vitest";
import { encodeQrToMatrix, qrMatrixToSvg } from "./qrcode";

// A finder pattern is a 7x7 block whose outer ring + inner 3x3 are dark.
// We spot-check the three corners to confirm the matrix is a real QR grid
// rather than noise from a table transcription bug.
function hasFinder(m: boolean[][], ox: number, oy: number): boolean {
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 7; x++) {
      const onRing = x === 0 || x === 6 || y === 0 || y === 6;
      const inCore = x >= 2 && x <= 4 && y >= 2 && y <= 4;
      const expectDark = onRing || inCore;
      if (m[oy + y][ox + x] !== expectDark) return false;
    }
  }
  return true;
}

describe("encodeQrToMatrix", () => {
  it("produces a square matrix with the QR version-size relationship", () => {
    const m = encodeQrToMatrix("https://example.com/p/duyetbot");
    expect(m.length).toBeGreaterThan(0);
    expect(m.every((row) => row.length === m.length)).toBe(true);
    // size = version*4 + 17, so (size - 17) is divisible by 4.
    expect((m.length - 17) % 4).toBe(0);
  });

  it("places finder patterns in all three corners", () => {
    const m = encodeQrToMatrix("https://example.com/p/duyetbot");
    const n = m.length;
    expect(hasFinder(m, 0, 0)).toBe(true);
    expect(hasFinder(m, n - 7, 0)).toBe(true);
    expect(hasFinder(m, 0, n - 7)).toBe(true);
  });

  it("selects the smallest version at the capacity boundary (v1-M holds 14 bytes)", () => {
    // Version 1 at ECC=MEDIUM has 16 data codewords; byte mode spends
    // 4 (mode) + 8 (count) header bits ≈ 2 codewords, leaving 14 data bytes.
    const v1 = encodeQrToMatrix("x".repeat(14));
    expect(v1.length).toBe(21); // version 1 → 21x21
    const v2 = encodeQrToMatrix("x".repeat(15));
    expect(v2.length).toBe(25); // spills into version 2 → 25x25
  });

  it("is deterministic for a fixed input", () => {
    const a = encodeQrToMatrix("https://example.com/p/duyetbot");
    const b = encodeQrToMatrix("https://example.com/p/duyetbot");
    expect(a).toEqual(b);
  });

  it("renders a self-contained SVG string", () => {
    const svg = qrMatrixToSvg(encodeQrToMatrix("https://example.com/p/duyetbot"));
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("</svg>");
    expect(svg).toContain("<path");
  });
});
