#!/bin/bash
# Seed skills into an open-managed-agents deployment via POST /v1/skills.
#
# By default this seeds the repo's built-in skill set (examples/skills/*) so a
# fresh deployment exposes data-viz, generate-html, query-sql, github,
# git-commit, and spreadsheet-xlsx without any extra downloads. Each skill
# folder is uploaded as a custom skill (KV metadata + R2 file bytes); binary
# files are base64-encoded so bytes survive intact through R2.
#
# Usage:
#   BASE=https://your-api.workers.dev KEY=your-api-key ./scripts/seed-skills.sh
#
# Also import Anthropic's skills catalog (github.com/anthropics/skills):
#   SEED_ANTHROPIC=1 ./scripts/seed-skills.sh
#
# Seed an arbitrary folder of skill dirs instead of the built-in set:
#   SKILLS_DIR=/path/to/skills ./scripts/seed-skills.sh

set -e
BASE="${BASE:-http://localhost:8787}"
KEY="${KEY:-test-key}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILTIN_SKILLS_DIR="${BUILTIN_SKILLS_DIR:-$REPO_ROOT/examples/skills}"

# Upload every immediate subdirectory of $1 as a skill.
seed_dir() {
  local base_dir="$1"
  if [ ! -d "$base_dir" ]; then
    echo "  (no skills found in $base_dir)"
    return
  fi
  for skill_dir in "$base_dir"/*/; do
    [ -d "$skill_dir" ] || continue
    local name
    name=$(basename "$skill_dir")
    echo "=== Importing skill: $name ==="

    # Build a JSON files array. Text files use utf8 encoding (raw content).
    # Binary files use base64 so bytes survive intact through R2.
    local payload
    payload=$(python3 - "$skill_dir" <<'PY'
import os, sys, json, base64
root = sys.argv[1].rstrip('/')
files = []
TEXT_EXT = {'.md', '.txt', '.json', '.yaml', '.yml', '.py', '.js', '.ts', '.html',
            '.css', '.csv', '.xml', '.toml', '.ini', '.sh', '.bash'}
for cur, _, names in os.walk(root):
    for fn in names:
        path = os.path.join(cur, fn)
        rel = os.path.relpath(path, root)
        ext = os.path.splitext(fn)[1].lower()
        with open(path, 'rb') as f:
            data = f.read()
        if ext in TEXT_EXT:
            try:
                files.append({"filename": rel, "content": data.decode('utf-8'), "encoding": "utf8"})
                continue
            except UnicodeDecodeError:
                pass
        files.append({"filename": rel, "content": base64.b64encode(data).decode('ascii'), "encoding": "base64"})
print(json.dumps({"files": files}))
PY
)

    if response=$(curl -sf "$BASE/v1/skills" \
      -H "x-api-key: $KEY" \
      -H "Content-Type: application/json" \
      -d "$payload" 2>/dev/null); then
      echo "  Created: $(echo "$response" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id','?'), d.get('name','?'))" 2>/dev/null)"
    else
      echo "  Failed"
    fi
  done
}

if [ -n "$SKILLS_DIR" ]; then
  # Explicit override: seed exactly the folder the caller pointed at.
  echo "Seeding skills from $SKILLS_DIR"
  seed_dir "$SKILLS_DIR"
else
  echo "Seeding built-in skills from $BUILTIN_SKILLS_DIR"
  seed_dir "$BUILTIN_SKILLS_DIR"

  if [ "$SEED_ANTHROPIC" = "1" ]; then
    ANTHROPIC_DIR="/tmp/anthropic-skills/skills"
    if [ ! -d "$ANTHROPIC_DIR" ]; then
      echo "Cloning github.com/anthropics/skills..."
      git clone https://github.com/anthropics/skills /tmp/anthropic-skills
    fi
    echo "Seeding Anthropic skills from $ANTHROPIC_DIR"
    seed_dir "$ANTHROPIC_DIR"
  fi
fi

echo "Done!"
