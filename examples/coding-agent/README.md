# Coding agent example

A generic long-running coding agent using the platform's default harness
(`DefaultHarness`) with the full `agent_toolset_20260401` toolset
(bash/read/write/edit/glob/grep/web_fetch/web_search), plus a demonstration of
attaching a GitHub repository as a session resource.

## What this demonstrates

- A minimal agent config that omits `"harness"` entirely, so the platform
  defaults to `"default"` (`registerHarness("default", () => new
  DefaultHarness())` in `apps/agent/src/index.ts`).
- **Attaching a GitHub repository is a session-time operation, not part of the
  agent config.** After creating the session, `run.sh` calls
  `POST /v1/sessions/:id/resources` with `{"type": "github_repository",
  "repo_url": ..., "checkout": {...}, "access": "read_write"}` — this clones
  the repo into the session's sandbox. Do not put repository config inside
  `agent.json`; agents are reusable configurations shared across many
  sessions, while a specific repo checkout belongs to one session.

## Prerequisites

- A running Open Managed Agents instance (Cloudflare `pnpm dev` or self-hosted
  `docker compose`), with a model provider key configured.
- `oma` CLI configured (`oma auth login`) or `curl` + an API key.
- An environment id (`oma envs list` / `POST /v1/environments`).
- For private repos: a vault credential id and pass it as `credential_id` in
  the resource body (see [AGENTS.md](../../AGENTS.md#github-repositories)).

## Build

```bash
docker build -t oma-example-coding-agent examples/coding-agent
```

The image bundles this README, `agent.json`, and `run.sh` for reference — it
does not reimplement the harness or sandbox.

## Run

```bash
docker run --rm \
  -e OMA_BASE_URL=https://your-instance \
  -e OMA_API_KEY=$KEY \
  -e OMA_ENV_ID=env_xxx \
  -e GITHUB_REPO_URL=https://github.com/your-org/your-repo \
  oma-example-coding-agent
```

`run.sh`:
1. `POST /v1/agents` with `agent.json` (no harness field → default).
2. `POST /v1/sessions` referencing the created agent + an environment id.
3. `POST /v1/sessions/:id/resources` to attach the GitHub repo **after**
   session creation.
4. `POST /v1/sessions/:id/events` with a `user.message` to kick off a turn.

## What happens at runtime

1. `SessionDO` provisions the sandbox and clones the attached GitHub repo
   into it.
2. `DefaultHarness` drives the model loop, giving the agent bash/read/write/
   edit/glob/grep/web_fetch/web_search tools to explore and modify the
   checked-out repo.
3. Tool calls and model output are persisted as `agent.*` events and
   broadcast over SSE; the session returns to `idle` when the turn completes.
