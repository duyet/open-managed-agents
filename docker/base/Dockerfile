# oma-runtime-base — generic sandbox toolset image.
#
# Published to GHCR as ghcr.io/duyet/oma-runtime-base:latest by
# .github/workflows/build-node-images.yml, and used as the DEFAULT
# `config.image` for the daytona / e2b / k8s / boxrun / litebox /
# docker-compose sandbox adapters when an environment doesn't pin one
# (DEFAULT_SANDBOX_IMAGE in packages/sandbox/src/ports.ts — issue #140:
# bare node:22-slim shipped no curl/git/python and apt couldn't
# self-install through the vault MITM proxy). Pre-loaded with the tools
# OMA's built-in toolset (bash/read/write/edit/glob/grep) and coding
# agents commonly need.
#
# This image is intentionally harness- and model-agnostic: the LLM call
# itself always happens on the platform side (apps/agent or apps/main-node),
# never inside the sandbox — so the *same* image works whether the agent
# runs the default in-process harness, the claude-agent-sdk harness, or an
# OpenAI-compatible (Grok, etc.) model. See docker/claude-agent-sdk and
# docker/coding-agent-openai-compat, and docs/runtimes.md, for why those
# variants exist despite that.
#
# Mirrors apps/agent/Dockerfile (the Cloudflare Containers sandbox-base
# image) so behavior is consistent across sandbox providers; not built FROM
# it because that image is pinned to cloudflare/sandbox's HTTP exec surface,
# which the daytona/e2b/k8s adapters don't use.
FROM node:22-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates \
    build-essential make \
    less file zip unzip \
    sqlite3 \
    python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

# ripgrep — pre-built binary
RUN ARCH=$(dpkg --print-architecture) && \
    RG_VERSION="14.1.1" && \
    if [ "$ARCH" = "amd64" ]; then RG_ARCH="x86_64"; else RG_ARCH="aarch64"; fi && \
    curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors --connect-timeout 30 \
      "https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/ripgrep-${RG_VERSION}-${RG_ARCH}-unknown-linux-musl.tar.gz" \
    | tar xz --strip-components=1 -C /usr/local/bin "ripgrep-${RG_VERSION}-${RG_ARCH}-unknown-linux-musl/rg"

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
