---
name: changeset
description: Decide whether a changeset is needed and draft it for open-managed-agents. Only @getoma/cli and @getoma/sdk are published; internal @duyet/oma-* packages never need one.
---

Determine whether the current change needs a changeset, then act.

1. See what changed: `git diff --name-only origin/main...HEAD` (or the staged / working diff).
2. A changeset is needed **only** if the diff touches `packages/cli` (`@getoma/cli`) or `packages/sdk` (`@getoma/sdk`) — the only published packages. Changes to apps, the console, docs, or any internal `@duyet/oma-*` package do **not** need one.
3. If needed, create `.changeset/<short-slug>.md` with frontmatter naming the affected published package(s). Both packages are pinned at `0.1.x` until further notice — **always use `patch`**, never `minor`/`major`, regardless of change size. Follow the bump with a one-line, user-facing changelog summary:
   ```md
   ---
   "@getoma/cli": patch
   ---

   Fix `oma sessions tail` reconnect after a dropped SSE stream.
   ```
   Prefer `pnpm changeset` when an interactive terminal is available; otherwise write the file directly.
4. If not needed, say so briefly and do nothing.

Full release flow: the "Releasing `@getoma/cli` and `@getoma/sdk`" section of `AGENTS.md`.
