# GitHub Actions in this repo

| Workflow | Purpose |
|---|---|
| `release.yml` | changeset-driven npm publish for the SDK / CLI packages |
| `build-sandbox-image.yml` | builds the agent sandbox container image and pushes to GHCR for OSS users to pull |
| `build-example-images.yml` | builds/pushes the `examples/**` demo images to GHCR |
| `self-improvement-agent.yml` | opt-in cron that calls an already-running OMA instance's REST API |
| `deploy-main.yml` | deploys `apps/main` (core API worker → `oma-managed-agents`) |
| `deploy-agent.yml` | deploys `apps/agent` (SessionDO + sandbox → `oma-sandbox-default`) |
| `deploy-integrations.yml` | deploys `apps/integrations` (webhook gateway → `oma-managed-agents-integrations`) |
| `deploy-website.yml` | builds + deploys `apps/web` (marketing site → `oma.duyet.net`) |
| `deploy-docs.yml` | builds + deploys `apps/docs` (docs site → `docs.oma.duyet.net`) |

## Deploy workflows

Each deploy workflow runs on push to `main` when files in its path change.
All require these repo secrets:

| Secret | Description |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with Workers permissions |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |

Path triggers are scoped per app plus its key dependency packages
so changes to `packages/shared/` trigger all workers that depend on it,
while changes to `apps/main/` only trigger the main worker.

## Self-host deploy

Fork the repo, fill in `apps/*/wrangler.jsonc` with your CF resource IDs,
add the two secrets above, and the workflows will deploy on push to main.
Alternatively, run `wrangler deploy` from each app dir.
