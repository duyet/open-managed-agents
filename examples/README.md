# Examples

Two kinds of examples live here:

## Harness demos (`examples/claude-agent-sdk/`, `examples/coding-agent/`, `examples/flue/`, `examples/self-improvement-agent/`)

Each is a small, self-contained Docker image (`agent.json` + `README.md` +
`run.sh`) that registers an agent, creates a session, and sends one message
against a running Open Managed Agents instance. They demonstrate specific
harness choices (`default`, `claude-agent-sdk`, `flue`) and session-resource
patterns (attaching a GitHub repo). Build one with:

```bash
docker build -t oma-example-<name> examples/<name>
docker run --rm -e OMA_BASE_URL=... -e OMA_API_KEY=... -e OMA_ENV_ID=... oma-example-<name>
```

Pre-built images are published to GHCR by
[`.github/workflows/build-example-images.yml`](../.github/workflows/build-example-images.yml)
on every push to `main` that touches `examples/**` — one independent, parallel
matrix job per example:

```
ghcr.io/duyet/oma-example-claude-agent-sdk
ghcr.io/duyet/oma-example-coding-agent
ghcr.io/duyet/oma-example-flue
ghcr.io/duyet/oma-example-self-improvement-agent
```

`examples/self-improvement-agent/` scans this repo's own health (typecheck,
tests, CI run history) and files a GitHub issue for each new failure class —
a read-only, issue-filing-only agent using the default harness and a
narrowly-scoped `gh` credential (`cap_cli`).

### Build-it-yourself (not in the GHCR matrix)

`examples/grok-coding-agent/` is a full Dockerfile/README/run.sh example —
same shape as the demos above — but isn't part of the CI build matrix, so
no `ghcr.io/duyet/oma-example-grok-coding-agent` image is published. It
demonstrates routing the same generic coding agent as `examples/coding-agent`
to xAI's Grok through an OpenAI-compatible Model Card (`provider:
"oai-compatible"`) instead of Anthropic — provider swap via config, no
harness or sandbox-image change. Build it locally the same way:
`docker build -t oma-example-grok-coding-agent examples/grok-coding-agent`.

## Config templates (`examples/agents/`, `examples/environments/`)

Plain, copy-paste-ready `agent.json` / `environment.json` bodies for common
personas — no Docker image, no harness demo, just `POST` the file as-is
(they follow the "Full Configuration" shape documented in
[`AGENTS.md`](../AGENTS.md#agent-configuration)):

| File | Persona |
|---|---|
| `examples/agents/coding-assistant.json` | General-purpose coding agent, default harness, full file/bash toolset, no web tools. See `examples/coding-agent/` for the fuller GitHub-repo-resource walkthrough of the same idea. |
| `examples/agents/data-analyst.json` | Data analysis agent (pandas/numpy/matplotlib/scikit-learn). Pair with `examples/environments/data-analyst.json` for the matching sandbox packages. |
| `examples/agents/research-agent.json` | Web research agent with `web_search` + `web_fetch` enabled and `aux_model` set so long fetched pages get summarized instead of dumped raw into context. |
| `examples/environments/data-analyst.json` | Environment config mirroring the `data-science` example in `AGENTS.md` — adds `matplotlib`/`scikit-learn` + `ffmpeg` on top of the default sandbox. |

```bash
# Register the agent
curl -s $BASE/v1/agents \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d @examples/agents/data-analyst.json

# Register the matching environment
curl -s $BASE/v1/environments \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d @examples/environments/data-analyst.json
```

These don't get a Docker image: they run against the platform's default
sandbox base image (`apps/agent/Dockerfile`) plus whichever
`environment.config.packages` you attach at session time — there's no
separate build step to publish.
