// Vitest config local to @duyet/oma-k8s-bridge.
//
// This app talks to the Kubernetes API via @kubernetes/client-node and
// spawns Node subprocesses — Node-native, not something the Cloudflare
// Workers pool (root vitest.config.ts) can run. Same pattern as
// packages/session-runtime.
//
// Run with:
//   pnpm --filter @duyet/oma-k8s-bridge test

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "threads",
    include: ["test/**/*.test.ts"],
    testTimeout: 10_000,
  },
});
