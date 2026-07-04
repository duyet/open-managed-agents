# GitHub Actions in this repo

This repo's CI publishes the OSS source — npm packages, sandbox container
image. **It does NOT deploy any worker to a Cloudflare account.**

| Workflow | Purpose |
|---|---|
| `release.yml` | changeset-driven npm publish for the SDK / CLI packages |
| `build-sandbox-image.yml` | builds the agent sandbox container image and pushes to GHCR for OSS users to pull |
| `build-example-images.yml` | builds/pushes the `examples/**` demo images to GHCR |
| `self-improvement-agent.yml` | opt-in cron that calls an already-running OMA instance's REST API to run the `examples/self-improvement-agent` scan (see [#24](https://github.com/duyet/open-managed-agents/issues/24)); no-ops unless an operator sets `OMA_API_KEY` as a repo secret. It's a scheduled *client* of the API, not a deploy workflow — no Cloudflare account involved. |

## Why no deploy workflows?

Earlier versions of this repo had `deploy.yml`, `deploy-staging.yml`,
`deploy-lane.yml`, etc. Those were removed because:

1. **Repo / deploy concern separation.** A deploy workflow in OSS
   couples this codebase to one operator's CF account. Anyone forking
   for self-host had to either re-wire the workflows or accept a red
   CI badge — neither is good.

2. **Hosted overlay needs to win.** The OSS `apps/*/wrangler.jsonc`
   files are templates; production deployments overlay extra bindings
   (e.g. a billing-meter service binding, real D1 IDs, custom domains).
   Letting OSS auto-deploy on `push: main` clobbered those overlays.

## Self-host deploy

You're on your own — fork the repo, fill in `apps/*/wrangler.jsonc`
with your CF resource IDs, run `wrangler deploy` from each app dir.
The hosted operator's deploy infra (separate private repo) is
documented in their own README and is not maintained here.

## OMA hosted

Deploys run from the operator's private `openma-hosted` repo via its
own GitHub Actions workflows. The `.oma-version` file there pins which
SHA of this repo gets shipped to prod.
