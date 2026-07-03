// Vitest config local to @duyet/oma-cap.
//
// Cap is pure-data + pure-function (no I/O), so it runs in plain Node
// rather than the workerd pool the rest of OMA uses. Following the same
// convention as packages/session-runtime.
//
// Run with:
//   pnpm --filter @duyet/oma-cap test

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "threads",
    include: ["test/**/*.test.ts"],
    testTimeout: 10_000,
  },
});
