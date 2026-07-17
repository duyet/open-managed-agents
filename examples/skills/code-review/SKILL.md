---
name: code-review
description: Review a diff for correctness, security, and maintainability before it ships. Trigger when the user asks to "review this code", "review my PR", "look over these changes", "is this safe to merge", or after you finish an edit and want a second pass. Reviews the change against what it claims to do — reads the surrounding code first, reports only issues that matter, ranked by severity.
---

# code-review

A review answers one question: **is this change correct, safe, and something
the team can live with?** Read before you judge — a diff in isolation lies. The
bug is usually in what the diff *doesn't* show: the caller that still passes the
old shape, the error path that's now unreachable, the invariant two files over.

## Scope the review first

1. **Get the diff.** `git diff main...HEAD` (or the branch/commit the user
   named). For an uncommitted change, `git diff` / `git diff --staged`.
2. **Read what it touches.** For every changed function, read its callers and
   the code it calls. `grep` the symbol across the repo. "Looks orthogonal" is
   how regressions ship.
3. **Know the intent.** What was this supposed to do — the issue, the PR body,
   the commit message? A change can be flawless code and still be the wrong
   change. Review against the goal, not just against the compiler.

## What to look for, in priority order

Spend your attention where the damage is greatest.

1. **Correctness** — Does it do what it claims? Off-by-one, inverted
   conditions, wrong operator, missing `await`, unhandled `null`/`undefined`,
   the empty-list and single-element cases, integer overflow, timezone/`Date`
   mistakes. Trace one real input through the new path by hand.
2. **Security** — Untrusted input reaching a sink: SQL/command/template
   injection, path traversal, SSRF, deserialization. Missing authz on a new
   route. Secrets in code, logs, or errors. A dependency bump to an unvetted
   version. See the checklist below.
3. **Error handling** — Failures that are swallowed, logged-and-ignored, or
   caught too broadly. Resources (connections, files, locks, timers) leaked on
   the error path. Partial writes that leave state inconsistent.
4. **Concurrency & data** — Races, unawaited promises, shared mutable state,
   N+1 queries, unbounded loops/allocations on user-controlled size, missing
   pagination, a migration that locks a hot table.
5. **Tests** — Is the new behavior actually tested? A test that can't fail when
   the logic breaks is theater. Check the edge cases the code added, not just
   the happy path.
6. **Maintainability** — Naming that misleads, a 200-line function that should
   be 50, duplicated logic, a leaked abstraction, dead code the change
   orphaned. Real, but never rank it above a correctness or security finding.

## Security checklist

- **Input at every boundary** is validated/escaped before it hits SQL, a shell,
  a filesystem path, an HTTP client, or an HTML template.
- **Parameterized queries** — never string-concatenated SQL. Never
  `eval`/`exec` on request data.
- **AuthZ, not just authN** — a new endpoint checks the caller may touch *this*
  resource, not merely that they're logged in.
- **Secrets** never land in source, logs, error messages, or the client bundle.
- **No new attack surface by default** — a route/flag/permission added here
  ships closed, opened deliberately.

## How to report

- **Rank by severity**, not by file order. Lead with anything that blocks:
  data loss, a security hole, a crash on a common input.
- **Be specific and actionable.** `file:line` + what's wrong + the fix or the
  question. "This is fragile" helps no one.
- **Separate blocking from optional.** Mark nits as nits. Don't gate a merge on
  taste; do gate it on a real bug.
- **Say when it's clean.** If you traced the risky paths and found nothing,
  say so plainly — "reviewed X, Y, Z, no blocking issues" is a real result, not
  a failure to find fault. Don't invent problems to look thorough.
- **Ask when unsure.** If you can't tell whether a case is handled, ask instead
  of asserting a bug that isn't there.

## Don't

- Don't rewrite the change yourself and call that a review — point, explain,
  let the author decide.
- Don't drown a real finding in twenty style nits.
- Don't approve code you didn't understand. If a section is opaque, that's
  itself worth surfacing.
