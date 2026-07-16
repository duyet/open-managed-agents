import "@testing-library/jest-dom/vitest";
import { afterAll, afterEach, beforeAll } from "vitest";
import { cleanup } from "@testing-library/react";
import { server } from "../mocks/server";

// ── jsdom polyfills for Radix Popover / cmdk Command ──────────────────
// jsdom implements neither the ResizeObserver/IntersectionObserver used by
// Floating-UI-based Radix popovers nor the pointer-capture / scrollIntoView
// element methods those components call while opening. Without these,
// rendering a Combobox / FilterChip popover throws. Guarded so a real
// implementation (if the environment ever gains one) still wins.
class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
if (!("ResizeObserver" in globalThis)) {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoopObserver;
}
if (!("IntersectionObserver" in globalThis)) {
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver =
    NoopObserver;
}
if (typeof Element !== "undefined") {
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
}

// Fail any test that fires a network request not explicitly handled —
// prevents "why are my tests flaky" debugging sessions where a stray
// fetch hits the real backend (or stalls forever).
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());
