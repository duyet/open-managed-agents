#!/usr/bin/env bash
#
# Manually publish the two public npm packages: @getoma/cli and @getoma/sdk.
# The normal path is the changesets Release workflow (OIDC trusted publisher).
# Use this for a first publish under the new @getoma scope, or when CI is unavailable.
#
# Usage:
#   NPM_TOKEN=npm_xxx ./scripts/publish-npm.sh            # publish
#   NPM_TOKEN=npm_xxx ./scripts/publish-npm.sh --dry-run  # build + pack, no publish
#   NPM_TOKEN=npm_xxx TAG=beta ./scripts/publish-npm.sh   # publish under a dist-tag
#
# Requires: an npm automation token (NPM_TOKEN) with publish rights on the
# @getoma scope. Create at npmjs.com → Access Tokens → Granular/Automation.
set -euo pipefail

cd "$(dirname "$0")/.."

PKGS=("@getoma/cli" "@getoma/sdk")
DRY_RUN=""
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN="1"
TAG="${TAG:-latest}"

if [[ -z "${NPM_TOKEN:-}" ]]; then
  echo "ERROR: NPM_TOKEN is not set. export NPM_TOKEN=npm_xxx" >&2
  exit 1
fi

# Scoped auth without touching the user's ~/.npmrc. Cleaned up on exit.
NPMRC="$(mktemp)"
trap 'rm -f "$NPMRC"' EXIT
cat > "$NPMRC" <<EOF
//registry.npmjs.org/:_authToken=${NPM_TOKEN}
@getoma:registry=https://registry.npmjs.org/
EOF
export NPM_CONFIG_USERCONFIG="$NPMRC"

# Ping only checks registry reachability — granular access tokens (the only
# npm token type since Nov 2025) 403 on whoami. An invalid token surfaces at publish.
echo "==> Verifying registry connectivity"
pnpm ping >/dev/null || { echo "ERROR: cannot reach npm registry" >&2; exit 1; }

echo "==> Installing deps (frozen)"
pnpm install --frozen-lockfile

for pkg in "${PKGS[@]}"; do
  dir="packages/${pkg#@getoma/}"   # @getoma/cli -> packages/cli
  ver="$(node -p "require('./$dir/package.json').version")"
  echo ""
  echo "==> $pkg@$ver  ($dir)"

  # Skip if this exact version is already on npm (idempotent, avoids 403 republish).
  if npm view "$pkg@$ver" version >/dev/null 2>&1; then
    echo "    already published — skipping"
    continue
  fi

  echo "    building"
  pnpm --filter "$pkg" run build

  if [[ -n "$DRY_RUN" ]]; then
    echo "    dry-run: packing"
    pnpm --filter "$pkg" pack --dry-run
  else
    echo "    publishing (tag=$TAG, access=public)"
    pnpm --filter "$pkg" publish --no-git-checks --access public --tag "$TAG"
    echo "    ✅ published $pkg@$ver"
  fi
done

echo ""
echo "==> Done${DRY_RUN:+ (dry-run)}."
