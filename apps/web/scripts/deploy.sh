#!/bin/sh
# Deploys the OMA web marketing site (apps/web) to BOTH the production
# (oma.duyet.net — top-level env) and staging (www.staging.oma.duyet.net —
# the `staging` env) environments, auto-reading Cloudflare credentials from
# the repo-root .env.local.
#
# We keep CF creds in .env.local (never committed; see .gitignore) and
# export only the CLOUDFLARE_* ones so wrangler works in a non-interactive
# shell (it otherwise demands CLOUDFLARE_API_TOKEN inline).
#
# Usage:
#   bash apps/web/scripts/deploy.sh            # prod + staging
#   bash apps/web/scripts/deploy.sh prod       # production only
#   bash apps/web/scripts/deploy.sh staging    # staging only
set -eu

# Repo root = apps/web/scripts/ -> ../../..
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
ENV_FILE="$ROOT/.env.local"

if [ ! -f "$ENV_FILE" ]; then
  echo "error: $ENV_FILE not found" >&2
  exit 1
fi

# Export only the Cloudflare credentials from .env.local.
matches=$(grep -E '^CLOUDFLARE_(API_TOKEN|ACCOUNT_ID|ZONE_ID)=' "$ENV_FILE" || true)
if [ -n "$matches" ]; then
  while IFS= read -r line; do
    k="${line%%=*}"; v="${line#*=}"; export "$k=$v"
  done <<EOF
$matches
EOF
fi

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "error: CLOUDFLARE_API_TOKEN missing in $ENV_FILE" >&2
  exit 1
fi

cd "$ROOT/apps/web"

TARGET="${1:-both}"

deploy_prod() {
  echo "==> deploying production (oma-web) -> oma.duyet.net"
  npx wrangler deploy --env=""
}

deploy_staging() {
  echo "==> deploying staging (oma-web-staging) -> www.staging.oma.duyet.net"
  npx wrangler deploy -e staging
}

case "$TARGET" in
  prod|production) deploy_prod ;;
  staging)         deploy_staging ;;
  both|"")         deploy_prod; deploy_staging ;;
  *) echo "unknown target: $TARGET (use prod | staging | both)" >&2; exit 1 ;;
esac

echo "done."
