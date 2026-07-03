---
name: changeset
description: Decide whether a changeset is needed and draft it for open-managed-agents. Only @duyet/oma-cli and @openma/sdk are published; internal @duyet/oma-* packages never need one.
---

Determine whether the current change needs a changeset, then act.

1. See what changed: `git diff --name-only origin/main...HEAD` (or the staged / working diff).
2. A changeset is needed **only** if the diff touches `packages/cli` (`@duyet/oma-cli`) or `packages/sdk` (`@openma/sdk`) — the only published packages. Changes to apps, the console, docs, or any internal `@duyet/oma-*` package do **not** need one.
3. If needed, create `.changeset/<short-slug>.md` with frontmatter naming the affected published package(s) and a semver bump (`patch` / `minor` / `major`), then a one-line, user-facing changelog summary:
   ```md
   ---
   "@duyet/oma-cli": patch
   ---

   Fix `oma sessions tail` reconnect after a dropped SSE stream.
   ```
   Prefer `pnpm changeset` when an interactive terminal is available; otherwise write the file directly.
4. If not needed, say so briefly and do nothing.

Full release flow: the "Releasing `@duyet/oma-cli` and `@openma/sdk`" section of `AGENTS.md`.
