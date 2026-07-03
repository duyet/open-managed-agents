# Claude Agent SDK example

Demonstrates an agent whose turns are driven by `@anthropic-ai/claude-agent-sdk`
(Claude Code's CLI running as a native subprocess) instead of Open Managed
Agents' default in-process model loop.

## What this demonstrates

- Setting `"harness": "claude-agent-sdk"` on an agent config selects
  `ClaudeAgentSdkHarness` (`apps/agent/src/harness/claude-agent-sdk-loop.ts`).
- This harness spawns Claude Code's CLI via `query()` from the SDK and bridges
  tool calls to OMA's sandbox through an in-process MCP server
  (bash/read/write/edit/glob/grep), translating the SDK's message stream into
  OMA `SessionEvent`s.
- **Self-hosted Node only.** It is wired up in `apps/main-node`'s
  `buildHarness` router (`metadata.harness === "claude-agent-sdk"`) because the
  SDK needs `child_process` spawning and a real filesystem — both unavailable
  inside a Cloudflare Workers isolate. It cannot run under `apps/agent`'s CF
  Worker deployment.

## Prerequisites

- A running self-hosted Open Managed Agents instance (`docker compose`), with
  `ANTHROPIC_API_KEY` configured.
- `oma` CLI configured (`oma auth login`) or `curl` + an API key.
- An environment id (`oma envs list` / `POST /v1/environments`).

## Build

```bash
docker build -t oma-example-claude-agent-sdk examples/claude-agent-sdk
```

The image just bundles this README, `agent.json`, and `run.sh` for reference —
it does not reimplement the harness. Run `run.sh` against a live OMA instance
to exercise it.

## Run

```bash
docker run --rm -e OMA_BASE_URL=https://your-instance -e OMA_API_KEY=$KEY \
  oma-example-claude-agent-sdk
```

`run.sh`:
1. `POST /v1/agents` with `agent.json` (harness: `claude-agent-sdk`).
2. `POST /v1/sessions` referencing the created agent + an environment id.
3. `POST /v1/sessions/:id/events` with a `user.message` to kick off a turn.

## What happens at runtime

1. `SessionDO` (or the Node session runtime) receives the message and starts
   `ClaudeAgentSdkHarness`.
2. The harness calls `query()` from `@anthropic-ai/claude-agent-sdk`, which
   spawns the Claude Code CLI as a subprocess.
3. Tool calls from the CLI are bridged to OMA's sandbox via an in-process MCP
   server exposing bash/read/write/edit/glob/grep.
4. The SDK's message stream is translated into OMA `agent.message` /
   `agent.tool_use` / `agent.tool_result` events and persisted to the event
   log.
