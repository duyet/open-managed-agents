import { defineConfig } from "vitest/config";

// Node pool — the CLI (bridge daemon) is a plain Node process, not a Worker.
// Run only via `pnpm --filter @getoma/cli test`; excluded from the root
// Workers-pool run.
export default defineConfig({
  test: {
    pool: "threads",
    include: ["src/**/*.test.ts"],
    testTimeout: 30000,
  },
});
