---
name: github
description: Work with GitHub effectively via the gh CLI — issues, pull requests, reviews, and CI checks. Trigger when the user asks to "open a PR", "create an issue", "review this PR", "check CI", "merge", or otherwise operate on a GitHub repo from the sandbox. Assumes gh is installed and authenticated; never force-pushes or force-merges.
---

# github

The sandbox ships the `gh` CLI. Prefer `gh` over raw `git push` to GitHub's web
API — it's authenticated, scriptable, and JSON-friendly (`--json` + `--jq`).

## Auth assumptions

- Auth is provided by the platform (a `cap_cli` credential injected at the
  network layer, or `GH_TOKEN`/`GITHUB_TOKEN` in the environment). Do **not**
  ask the user to paste a token, and don't run `gh auth login` interactively.
- Verify once: `gh auth status`. If it fails, report that the repo needs a
  GitHub credential attached (a `gh` `cap_cli` credential or `GH_TOKEN`) — don't
  try to work around missing auth.

## Issues

```bash
gh issue list --state open --limit 20 --json number,title,labels
gh issue view 42 --comments
gh issue create --title "…" --body "…" --label bug            # never invent labels that don't exist
gh issue comment 42 --body "…"
gh issue close 42 --comment "fixed in #57"
```

## Pull requests

```bash
# create from the current branch (never from the default branch — branch first)
gh pr create --title "feat(x): …" --body "$(cat <<'EOF'
## What
## Why
## Testing
EOF
)" --base main
gh pr list --json number,title,headRefName,statusCheckRollup
gh pr view 57 --json title,body,reviewDecision,mergeStateStatus
gh pr diff 57
```

Rules:
- **Branch before you commit.** If you're on the default branch (`main`/
  `master`), create a feature branch first — never push commits straight to the
  default branch.
- Write a real PR body: what changed, why, how it was tested. No empty
  descriptions.
- **Never `--force` / `--force-with-lease` push** unless the user explicitly
  asks and understands the branch will be rewritten. Rewriting shared history is
  destructive.

## Reviews

```bash
gh pr review 57 --comment --body "…"     # leave feedback without a verdict
gh pr review 57 --approve --body "LGTM"
gh pr review 57 --request-changes --body "…"
```

When reviewing, read the diff (`gh pr diff`), check the PR description matches
the change, and look at CI before approving.

## CI / checks

```bash
gh pr checks 57                          # summary table; exit code reflects state
gh pr checks 57 --watch                  # block until checks finish
gh run list --branch my-branch --limit 5
gh run view <run-id> --log-failed        # only the failing step's logs
```

Diagnose a red check by reading `--log-failed` before guessing. Re-run only
genuinely flaky jobs (`gh run rerun <id> --failed`), and don't re-run more than
a couple times — a consistently failing check is a real failure.

## Merging

- Only merge when the user asks. Confirm checks are green and required reviews
  are in first: `gh pr view 57 --json mergeStateStatus,reviewDecision`.
- Use `gh pr merge 57 --squash` (or the repo's stated convention). **Never** use
  `--admin` to bypass required checks, and never enable auto-merge on
  release-please / "release" PRs — leave those for a human.

## Style

- Use `--json … --jq …` for anything you'll parse; don't scrape human output.
- Reference issues/PRs by `#number` in bodies so GitHub links them.
- Match the repo's existing conventions (commit format, PR template, base
  branch) before imposing your own.
