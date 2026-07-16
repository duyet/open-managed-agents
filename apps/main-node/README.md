# @duyet/oma-main-node

**Naming note:** despite the name, this isn't a Kubernetes "main node" —
it's the self-host Node.js flavor of the `apps/main` control-plane app.

Same REST/SSE API as the `apps/main` Cloudflare Worker (agents, sessions,
vaults, memory stores, etc.), reimplemented on plain Node/Hono against
SQLite or Postgres instead of D1/KV/R2 — the server used for `docker compose`
self-hosting.

Run it with `pnpm --filter @duyet/oma-main-node start`, or via
`docker compose up` from the repo root. See
[`docs/self-host.md`](../../docs/self-host.md) for the full self-host guide.
