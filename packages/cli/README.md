# @duyet/oma-cli

Command-line client for [oma](https://oma.duyet.net) managed agents.

> **Pre-1.0.** API surface and command names may still change in a minor release.

## Install

```bash
npm i -g @duyet/oma-cli
```

This installs an `oma` binary on your `PATH`. (If a different `oma` is already installed, npm will overwrite or warn — both are safe.)

## Configure

Either log in interactively (recommended) or set env vars.

```bash
# Browser handoff (default), device-code, or paste-token for headless boxes
oma auth login                 # opens the console, waits for the redirect back
oma auth login --device        # print a code, approve it in any browser
oma auth login --paste-token   # fully headless: paste a token minted in the console
```

Or point the CLI at a deployment directly:

```bash
export OMA_API_KEY=oma_...
export OMA_BASE_URL=https://app.oma.duyet.net   # default
```

Generate an API key from the [oma console](https://oma.duyet.net) → API Keys.

## Usage

```bash
oma agents list
oma agents create --name my-agent --model claude-sonnet-4-6
oma sessions list
oma sessions create --agent <agent-id> --env <env-id>
oma session <session-id> tail        # follow events live
oma linear publish <agent-id> --env <env-id>
oma api                              # HTTP API quick reference
```

Run `oma --help` for the full command tree.

## License

MIT
