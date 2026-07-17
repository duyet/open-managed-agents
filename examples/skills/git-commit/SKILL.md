---
name: git-commit
description: Create clean git commits using Conventional Commits. Trigger when the user asks to "commit", "commit this", "save my work", "make a commit", or after you finish a change and it's time to record it. Produces small, atomic, well-scoped commits with meaningful messages — and never pushes or amends published history unless explicitly asked.
---

# git-commit

Good commits are **small, atomic, and self-describing**: one logical change per
commit, a message that says what changed and why. Do not push unless the user
asks.

## Before committing

1. `git status` and `git diff` — know exactly what you're about to record.
2. **Stage deliberately.** `git add <specific paths>` for the change you're
   describing. Avoid `git add -A` when the working tree has unrelated edits.
3. **Don't commit junk:** secrets/tokens, `.env` files, build output,
   `node_modules`, editor cruft, large binaries, debug `console.log`/`print`.
   If something shouldn't be tracked, add it to `.gitignore` instead.
4. **Not on the default branch.** If you're on `main`/`master` and this isn't a
   trivial fixup the user asked for, create a branch first.

## Conventional Commits format

```
<type>(<scope>): <summary>

<body — why, not just what>

<footer — refs, BREAKING CHANGE>
```

- **type:** `feat` · `fix` · `docs` · `refactor` · `test` · `chore` · `perf` ·
  `build` · `ci` · `style` · `revert`.
- **scope:** the area touched (`auth`, `api`, `parser`, …) — keep it consistent
  with scopes already used in `git log`.
- **summary:** imperative mood, lowercase, no trailing period, <= ~72 chars
  ("add retry to fetch", not "added" / "adds" / "Added.").
- **body** (optional): wrap ~72 cols, explain the reasoning and any tradeoff —
  the diff already shows *what*.
- **breaking change:** footer `BREAKING CHANGE: …` (or `type!:` in the header).

Examples:
```
feat(agent): add exponential backoff to model retries
fix(session): stop dropping events when the DO restarts mid-turn
docs(readme): document the seed-skills workflow
```

## Small and atomic

- One concern per commit. If you did two unrelated things, make two commits
  (`git add -p` to split a mixed working tree by hunk).
- A commit should leave the tree in a working state — don't commit code that
  doesn't build if you can help it.
- Prefer several focused commits over one giant "misc changes" blob. Reviewers
  and `git bisect` both benefit.

## Match the repo

Read `git log --oneline -15` first and mirror the existing style — some repos
require a scope, some use different types, some squash on merge. Conform to what
you find rather than importing a different convention.

## Don't, unless explicitly asked

- **Don't `git push`.** Committing and pushing are separate decisions; leave the
  push to the user unless they said "commit and push".
- **Don't `commit --amend`, rebase, or force-anything** on commits that are
  already pushed — that rewrites shared history.
- **Don't `git reset --hard` or `git clean -fd`** to "clean up" — you can
  destroy uncommitted work. Prefer `git stash` if you need a clean tree.
- Don't add automated trailers/signatures unless the repo asks for them.
