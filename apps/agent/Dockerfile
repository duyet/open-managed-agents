# OMA Default Sandbox Base Image
# Based on cloudflare/sandbox:0.9.1 which already has: Node.js 20, npm, git, jq, curl
# We add: Python 3.12, build tools, ripgrep, gh CLI
# IMPORTANT: keep this version in lock-step with @cloudflare/sandbox in package.json,
# otherwise the container's HTTP routes drift from the SDK and exec calls 500.
#
# Image size budget: must fit within 2000MB (Cloudflare Containers "lite" limit).
# Pre-installed tools that exceed this are available via `apt-get install`
# at runtime — the sandbox container stays alive for the session, so the
# one-time install cost is acceptable.

FROM docker.io/cloudflare/sandbox:0.9.1

ENV DEBIAN_FRONTEND=noninteractive

# Core system tools (minimal — agents install what they need at runtime)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential make cmake \
    less file \
    zip unzip \
    sqlite3 \
    sudo \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI — common enough that cold-installing every session adds up
RUN curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors --connect-timeout 30 \
      https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# ripgrep — pre-built binary (~5MB)
RUN ARCH=$(dpkg --print-architecture) && \
    RG_VERSION="14.1.1" && \
    if [ "$ARCH" = "amd64" ]; then RG_ARCH="x86_64"; else RG_ARCH="aarch64"; fi && \
    curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors --connect-timeout 30 \
      "https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/ripgrep-${RG_VERSION}-${RG_ARCH}-unknown-linux-musl.tar.gz" \
    | tar xz --strip-components=1 -C /usr/local/bin "ripgrep-${RG_VERSION}-${RG_ARCH}-unknown-linux-musl/rg"

# uv + Python 3.12 (minimal — no pandas/numpy to save ~150MB)
RUN curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors --connect-timeout 30 \
      https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"
RUN uv python install 3.12 && \
    uv venv /opt/venv --python 3.12 --seed
ENV VIRTUAL_ENV=/opt/venv
ENV PATH="/opt/venv/bin:${PATH}"
RUN uv pip install --no-cache \
    requests httpx pyyaml toml \
    pytest black ruff
RUN uv cache clean

# Clean up pip/uv caches
RUN rm -rf /root/.cache/pip

# Go and Rust are NOT pre-installed to keep image under 2000MB.
# Agents can install them at runtime:
#   Go:   curl -fsSL https://go.dev/dl/go1.22.5.linux-amd64.tar.gz | tar -xz -C /usr/local
#   Rust: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
