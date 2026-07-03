# Flue harness example

Demonstrates an agent whose turns are driven by the Flue harness
(`FlueHarness`), a meta-harness that bridges Flue's own agent runtime into
OMA's sandbox, provider, and event log.

## What this demonstrates

- Setting `"harness": "flue"` on an agent config selects `FlueHarness`
  (`apps/agent/src/harness/flue-loop.ts`), registered in
  `apps/agent/src/index.ts` via `registerHarness("flue", () => new
  FlueHarness())`.
- Unlike `claude-agent-sdk`, Flue runs both on the Cloudflare Worker (`apps/agent`)
  and self-hosted Node (`apps/main-node`) — it does not need `child_process` or
  a real filesystem.
- Flue's runtime, provider, and sandbox are bridged through
  `apps/agent/src/harness/flue/{runtime-bridge,provider-bridge,sandbox-bridge,translate}.ts`.

## Prerequisites

- A running Open Managed Agents instance (Cloudflare `pnpm dev` or self-hosted
  `docker compose`), with a model provider key configured.
- `oma` CLI configured (`oma auth login`) or `curl` + an API key.
- An environment id (`oma envs list` / `POST /v1/environments`).

## Build

```bash
docker build -t oma-example-flue examples/flue
```

The image bundles this README, `agent.json`, and `run.sh` for reference — it
does not reimplement the harness.

## Run

```bash
docker run --rm -e OMA_BASE_URL=https://your-instance -e OMA_API_KEY=$KEY \
  -e OMA_ENV_ID=env_xxx oma-example-flue
```

`run.sh`:
1. `POST /v1/agents` with `agent.json` (harness: `flue`).
2. `POST /v1/sessions` referencing the created agent + an environment id.
3. `POST /v1/sessions/:id/events` with a `user.message` to kick off a turn.

## What happens at runtime

1. `SessionDO` receives the message and starts `FlueHarness` for the turn
   (see commit `cc4f308` — the harness configures the Flue runtime before
   dispatch so `FlueHarness` actually runs a turn).
2. `FlueHarness` bridges the model provider, sandbox tool execution, and
   translates Flue's internal event stream into OMA `SessionEvent`s
   (`agent.message`, `agent.tool_use`, `agent.tool_result`, etc.).
3. Events are persisted to the append-only event log and broadcast over SSE.
