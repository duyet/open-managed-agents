#!/bin/sh
# Builds and tags every runtime image in the docker/ matrix as
# oma-runtime-<kind>. Run from the repo root or anywhere — paths are
# resolved relative to this script.
#
#   docker/build.sh                 # build all kinds
#   docker/build.sh claude-agent-sdk  # build one kind
set -eu

DIR="$(cd "$(dirname "$0")" && pwd)"
KINDS="base claude-agent-sdk coding-agent-openai-compat"

if [ $# -gt 0 ]; then
  KINDS="$*"
fi

echo "Building oma-runtime-base first (the other kinds FROM it)..."
docker build -t oma-runtime-base:latest -f "$DIR/base/Dockerfile" "$DIR/base"

for kind in $KINDS; do
  [ "$kind" = "base" ] && continue
  echo "Building oma-runtime-$kind..."
  docker build -t "oma-runtime-$kind:latest" -f "$DIR/$kind/Dockerfile" "$DIR/$kind"
done

echo "Done. Images:"
docker images --filter "reference=oma-runtime-*" --format "  {{.Repository}}:{{.Tag}}"
