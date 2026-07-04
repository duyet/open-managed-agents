# @duyet/oma-cli

Command-line client for [oma](https://oma.duyet.net) managed agents.

> **Beta.** API surface and command names may change before 0.1.0 final.

## Install

```bash
npm i -g @duyet/oma-cli
```

This installs an `oma` binary on your `PATH`. (If a different `oma` is already installed, npm will overwrite or warn — both are safe.)

## Configure

```bash
export OMA_API_KEY=sk_...
export OMA_BASE_URL=https://api.oma.duyet.net   # default
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
