# Self-improvement agent example

Implements [#24](https://github.com/duyet/open-managed-agents/issues/24): an
agent that scans this repo's health (typecheck, tests, CI run history) and
files a GitHub issue for each new failure class that isn't already tracked —
closing the loop on autonomous maintenance without adding any new platform
code. This is a config + prompt exercise: a regular OMA agent, the default
harness, the built-in toolset, and a narrowly-scoped `gh` credential.

## What this demonstrates

- A minimal agent config (`agent.json`) that omits `"harness"` (defaults to
  `DefaultHarness`) and uses only `agent_toolset_20260401`
  (bash/read/write/edit/glob/grep are what it needs to run `pnpm`/`gh`).
- **The credential is scoped to issues, not full repo access.** The current
  credential type for injecting CLI auth into the sandbox is `cap_cli`
  (`packages/api-types/src/types.ts`), not the `command_secret` type named in
  the original issue text — `command_secret` was replaced because it leaked
  tokens into the subprocess env; `cap_cli` injects the token at the
  network/outbound-proxy layer instead (`apps/agent/src/oma-sandbox.ts`,
  `githubAuthHandler`), so the token never enters the sandbox's process
  environment. `run.sh` creates a vault credential with
  `{"type": "cap_cli", "cli_id": "gh", "token": "..."}`, matching
  `packages/cap/src/builtin/gh.ts`.
- **The real guardrail is the PAT's scopes, not just prompt wording.** Mint a
  **fine-grained GitHub PAT** with only:
  - `Issues: Read and write`
  - `Actions: Read-only` (for `gh run list` / `gh run view`)
  - `Contents: Read-only`
  - `Metadata: Read-only` (mandatory default)

  and explicitly **not** `Contents: Read and write`, not `Pull requests:
  Read and write`, not `Administration`. Because `cap_cli` injects this same
  token on every `github.com`/`api.github.com` request the sandbox makes
  (git push included), a scoped-down PAT makes "never push/merge" a fact
  about the credential, not just an instruction the model has to obey. The
  system prompt in `agent.json` states the guardrail explicitly too (defense
  in depth), but don't rely on the prompt alone — scope the token.
- A `github_repository` session resource (attached by `run.sh`, not baked
  into `agent.json` — same reasoning as the `coding-agent` example: repo
  attachment is session-time, agents are reusable) with `"access":
  "read_only"`, so `pnpm typecheck`/`pnpm test` have a checkout to run
  against.
- No new harness, no new tool. The only "new" wiring is a vault + a `gh`
  credential and, optionally, a scheduled trigger (below).

## Prerequisites

- A running Open Managed Agents instance (Cloudflare `pnpm dev` or self-hosted
  `docker compose`), with a model provider key configured.
- An environment id (`oma envs list` / `POST /v1/environments`) whose image
  has `pnpm`/Node **and the `gh` CLI binary** available. `cap_cli` injects
  the auth header on outbound requests — it does **not** install `gh`
  itself, so if the sandbox base image's `apt` sources don't already carry
  a `gh` package (Ubuntu/Debian only added it to the default archive
  recently; older bases need GitHub's own apt repo added first), point
  `packages.apt` at a package that resolves on that base image, or use a
  container image that bundles `gh` already. Verify with `gh --version`
  inside a throwaway session before relying on the scheduled run.
- Networking that reaches `github.com`, `api.github.com` (repo clone +
  `gh`), and the npm registry for `pnpm install` — either
  `"networking": {"type": "unrestricted"}` or `"limited"` with those hosts in
  `allowed_hosts` plus `"allow_package_managers": true`.
- A fine-grained GitHub PAT scoped as described above (or an existing
  `cap_cli`/`gh` vault credential id — see `OMA_VAULT_ID` below). You can
  also provision the vault + credential ahead of time with the `oma` CLI
  instead of letting `run.sh` mint one: `oma vaults create
  self-improvement-agent-vault` then `oma cli add --vault <id> --name
  "gh (issues-only)" --cli-id gh --token <pat>` — then pass that vault id as
  `OMA_VAULT_ID`.

## Build

```bash
docker build -t oma-example-self-improvement-agent examples/self-improvement-agent
```

## Run

```bash
docker run --rm \
  -e OMA_BASE_URL=https://your-instance \
  -e OMA_API_KEY=$KEY \
  -e OMA_ENV_ID=env_xxx \
  -e GH_ISSUES_TOKEN=github_pat_xxx \
  oma-example-self-improvement-agent
```

`run.sh`:
1. `POST /v1/agents` with `agent.json` (no harness field → default).
2. Creates a vault + `cap_cli`/`gh` credential from `GH_ISSUES_TOKEN` (skip
   this by passing `OMA_VAULT_ID` for an existing vault — recommended for
   recurring runs so a fresh credential isn't minted every time).
3. `POST /v1/sessions` with `vault_ids: [<vault id>]`.
4. `POST /v1/sessions/:id/resources` to attach this repo, read-only.
5. `POST /v1/sessions/:id/events` with a `user.message` to kick off the scan.

## What happens at runtime

1. `SessionDO` provisions the sandbox and clones the repo read-only.
2. `DefaultHarness` drives the model loop. The agent runs `pnpm typecheck &&
   pnpm test`, inspects `gh run list` output, cross-checks `gh issue list` to
   avoid duplicates, and files `gh issue create --label agent-task` for each
   new failure class. `gh`'s HTTPS calls to `api.github.com` are
   transparently authenticated by the outbound proxy using the vault's
   `cap_cli` credential — the token never enters the sandbox.
3. Tool calls and model output are persisted as `agent.*` events and
   broadcast over SSE; the session returns to `idle` when the scan completes.

## Scheduling

Two ways to run this on a recurring basis — pick one:

### Option A — GitHub Actions cron (recommended for self-hosted instances)

See `.github/workflows/self-improvement-agent.yml`. It runs `run.sh` (via
`docker run`, no local build needed — it pulls the published
`oma-example-self-improvement-agent` image built by
`build-example-images.yml`) on a cron schedule. It expects three repository
secrets: `OMA_BASE_URL`, `OMA_API_KEY`, `OMA_ENV_ID`, and either
`OMA_VAULT_ID` or `GH_ISSUES_TOKEN`. The `scan` job is gated with `if:
${{ secrets.OMA_API_KEY != '' }}` so the workflow no-ops (doesn't fail) on
forks that haven't configured an OMA instance — it only does something once
an operator opts in by adding the secrets.

This workflow only ever talks to an OMA instance's REST API over `curl`; it
does not deploy anything to Cloudflare, matching the
[`.github/workflows/README.md`](../../.github/workflows/README.md) policy
that this repo's CI doesn't own any operator's deployment.

### Option B — `/loop` skill (interactive/dev use)

From a Claude Code session with this repo's skills available, run
`run.sh` once manually (or wrap the four curl calls above in a prompt) under
`/loop 6h` (or your preferred interval) to re-trigger the scan periodically
within a long-lived session — useful for local iteration without wiring up
GitHub Actions secrets.

## Verifying the command shape without filing a real issue

Checked `gh issue create --help`: there is no `--dry-run` flag. The only
side-effect-free options are `-w`/`--web` (opens a browser instead of
POSTing — not usable headlessly) and `-R`/`--repo` to point at a different
repository than the current checkout.

**No `gh issue create` command was executed as part of building or
verifying this example** — not against this repo, not against any other
repo. Verification here is by inspection only: given the system prompt's
step 4 (`agent.json`), and the flags confirmed valid by `--help` above, the
agent would run something shaped like:

```bash
gh issue create \
  --title "typecheck: TS2345 in apps/agent/src/example.ts" \
  --body "pnpm typecheck failed with: <exact tsc error>. Likely cause: <hypothesis>." \
  --label agent-task
```

`--title`, `--body`, and `--label` are all flags `gh issue create --help`
lists as valid (confirmed above); `-R owner/repo` would let an operator
point a manual test run at a disposable repo they own if they want an
end-to-end check beyond this inspection, but doing so is left to the
operator — it was deliberately not done here.
