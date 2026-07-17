---
name: dockerfile
description: Write and improve Dockerfiles that build small, cache-friendly, secure images. Trigger when the user asks to "write a Dockerfile", "containerize this", "shrink my image", "why is my build slow", "review this Dockerfile", or is setting up a container build. Covers layer caching and build order, multi-stage builds, non-root runtime, pinned base images, and the common footguns.
---

# dockerfile

Three things make a Dockerfile good: it **builds fast on re-run** (cache), the
image is **small** (multi-stage, slim base), and it **runs safely** (non-root,
no secrets baked in). Most Dockerfiles get all three wrong the same way — by
copying everything first and installing dependencies after. See
`Dockerfile.example` for an annotated multi-stage template.

## Order layers by change frequency

Docker caches each instruction and invalidates everything after the first
changed layer. So put what changes *least* on top, what changes *most* on the
bottom. The classic win — install deps before copying source, because your lock
file changes far less often than your code:

```dockerfile
# GOOD — deps cached across every source-only change
COPY package.json package-lock.json ./
RUN npm ci
COPY . .            # source changes don't bust the npm layer above
```

```dockerfile
# BAD — every one-line code edit reinstalls all dependencies
COPY . .
RUN npm ci
```

(Same shape in any ecosystem: `requirements.txt`/`pyproject.toml` before the
Python source, `go.mod`/`go.sum` before the Go source, `Cargo.toml` before the
Rust source.)

## Multi-stage: build fat, ship thin

Compile/install in a build stage with the full toolchain, then copy only the
runtime artifacts into a clean, minimal final image. The compilers, dev
headers, and caches never reach production.

```dockerfile
FROM node:22 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
USER node
CMD ["node", "dist/server.js"]
```

## Smaller and faster

- **Pin the base image** to a specific tag/digest (`node:22.4-slim`, not
  `node:latest`) — reproducible builds, no surprise breakage. Prefer `-slim` or
  `-alpine` (mind alpine's musl libc for native deps); `distroless` for a
  runtime with no shell/package manager at all.
- **One `RUN` for a package install + cleanup**, so the cleanup lands in the
  same layer (deleting files in a later layer doesn't shrink the image):
  ```dockerfile
  RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
      && rm -rf /var/lib/apt/lists/*
  ```
- **`.dockerignore`** — exclude `.git`, `node_modules`, build output, `.env`,
  test fixtures. It shrinks the build context (faster) and stops secrets and
  junk from being copied by a broad `COPY . .`.
- **Use `COPY`, not `ADD`** — `ADD` silently auto-extracts archives and fetches
  URLs. `COPY` is predictable; reach for `ADD` only when you actually want those.

## Run it safely

- **Never run as root.** Create/`USER` a non-root user for the runtime stage —
  a container escape as root is far worse than as an unprivileged user.
- **No secrets in the image.** `ENV`/`ARG`/`COPY`-ing a token bakes it into a
  layer forever, readable by anyone with the image. Inject secrets at *run*
  time (env, mounted file) or use BuildKit `--mount=type=secret` for build-time
  ones — never `ARG API_KEY`.
- **Prefer exec-form `CMD`/`ENTRYPOINT`** (`["node","server.js"]`, JSON array)
  over shell form, so your process is PID 1 and receives `SIGTERM` for clean
  shutdown.
- **`EXPOSE` the real port** and `HEALTHCHECK` long-running services so the
  orchestrator knows when the container is actually ready.

## Common footguns

- `latest` base tag → non-reproducible, breaks silently on upstream changes.
- `apt-get upgrade` in a build → non-deterministic images; pin instead.
- `COPY . .` before installing deps → cache busted on every edit.
- Secrets via `ARG`/`ENV` → permanently embedded in image history.
- Running as root, shell-form `CMD` → signal-handling and security problems.
