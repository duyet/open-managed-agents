---
name: preflight
description: Run the full local pre-push gate (typecheck + all vitest pools) for open-managed-agents. Use before pushing or opening a PR — no CI workflow gates PRs in this repo, so this is the only gate.
---

Run the repo's complete local verification gate, in order, from the repo root.

1. `pnpm typecheck` — root `tsc --noEmit` plus the node-only typecheck pass.
2. `pnpm test` — runs all three vitest suites in sequence (Cloudflare Workers pool → node-pool packages → console).

Both are composite scripts in the root `package.json`. Run them **as-is** — do not substitute the individual sub-runs (`vitest run`, `test:packages`, `test:console`); they drift when the scripts change.

Report the outcome plainly:
- If both pass, say so and that the branch is safe to push.
- If either fails, show the failing output and **stop** — do not report success, and never skip a suite silently. Fix forward, or surface the failure and ask.

Why this skill exists: there is no test/typecheck GitHub workflow, so nothing gates PRs server-side. This local run is the gate.
