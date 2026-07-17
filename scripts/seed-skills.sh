#!/bin/bash
# Seed skills into an open-managed-agents deployment via POST /v1/skills.
#
# By default this seeds the repo's built-in skill set (examples/skills/*) so a
# fresh deployment exposes data-viz, generate-html, query-sql, github,
# git-commit, spreadsheet-xlsx, code-review, web-research, api-design,
# dockerfile, and brand-design without any extra downloads. Each skill folder
# is uploaded as a custom skill (KV metadata + R2 file bytes); binary files are
# base64-encoded so bytes survive intact through R2.
#
# Usage:
#   BASE=https://your-api.workers.dev KEY=your-api-key ./scripts/seed-skills.sh
#
# Also import Anthropic's skills catalog (github.com/anthropics/skills):
#   SEED_ANTHROPIC=1 ./scripts/seed-skills.sh
#
# Seed an arbitrary folder of skill dirs instead of the built-in set:
#   SKILLS_DIR=/path/to/skills ./scripts/seed-skills.sh
#
# Fetch named skills from the skills.sh registry (comma-separated). skills.sh is
# a discovery frontend for the `skills` CLI ecosystem — every source resolves to
# a GitHub repo, so we download the repo tarball and seed the SKILL.md dirs it
# contains. Entries are registry ids / GitHub sources:
#   "owner/repo"        -> seed every skill (SKILL.md dir) in the repo
#   "owner/repo/skill"  -> seed only the named skill in the repo
#   SEED_SKILLS_SH="vercel-labs/agent-skills/web-design-guidelines,owner/repo" \
#     ./scripts/seed-skills.sh
#
# Fetch skills from any git repo (GitHub, GitLab, self-hosted; comma-separated):
#   SEED_FROM_REPO="https://github.com/anthropics/skills" ./scripts/seed-skills.sh
#
# A download/extract failure for one entry is reported loudly and skipped; the
# rest still seed.

set -e
BASE="${BASE:-http://localhost:8787}"
KEY="${KEY:-test-key}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILTIN_SKILLS_DIR="${BUILTIN_SKILLS_DIR:-$REPO_ROOT/examples/skills}"

# Upload a single skill directory (one that contains a SKILL.md) as a skill.
seed_skill_dir() {
  local skill_dir="$1"
  [ -d "$skill_dir" ] || return 0
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
}

# Upload every immediate subdirectory of $1 as a skill.
seed_dir() {
  local base_dir="$1"
  if [ ! -d "$base_dir" ]; then
    echo "  (no skills found in $base_dir)"
    return
  fi
  for skill_dir in "$base_dir"/*/; do
    [ -d "$skill_dir" ] || continue
    seed_skill_dir "$skill_dir"
  done
}

# Seed every skill (any directory containing a SKILL.md) found anywhere under a
# tree. $1 = tree root, $2 = optional single skill name to seed exclusively.
# Returns non-zero (without aborting a caller that uses `|| ...`) if nothing
# matched, so the caller can report a loud per-entry failure.
seed_repo_tree() {
  local root="$1" want="$2" found=0 skillmd dir
  while IFS= read -r skillmd; do
    dir=$(dirname "$skillmd")
    if [ -n "$want" ] && [ "$(basename "$dir")" != "$want" ]; then
      continue
    fi
    seed_skill_dir "$dir"
    found=$((found + 1))
  done < <(find "$root" -type f -name SKILL.md 2>/dev/null | sort)
  if [ "$found" -eq 0 ]; then
    return 1
  fi
}

# Fetch one skills.sh / GitHub entry ("owner/repo" or "owner/repo/skill") and
# seed the SKILL.md dirs it contains. Never aborts the run — a failure is
# reported and skipped.
fetch_skills_sh_entry() {
  local entry="$1" p1 p2 p3 rest slug want tmp
  IFS='/' read -r p1 p2 p3 rest <<< "$entry"
  if [ -z "$p1" ] || [ -z "$p2" ]; then
    echo "!! Invalid skills.sh entry '$entry' — expected owner/repo[/skill] (skipping)"
    return 0
  fi
  slug="$p1/$p2"
  want="$p3"
  echo "=== Fetching '$slug'${want:+ (skill: $want)} from skills.sh/GitHub ==="

  tmp=$(mktemp -d)
  # The GitHub tarball endpoint follows the default branch and redirects to
  # codeload — the same bytes `npx skills add owner/repo` downloads.
  if ! curl -sfL "https://api.github.com/repos/$slug/tarball" -o "$tmp/repo.tar.gz"; then
    echo "!! Download failed for '$slug' (skipping)"
    rm -rf "$tmp"
    return 0
  fi
  if ! tar -xzf "$tmp/repo.tar.gz" -C "$tmp" 2>/dev/null; then
    echo "!! Extract failed for '$slug' (skipping)"
    rm -rf "$tmp"
    return 0
  fi
  if ! seed_repo_tree "$tmp" "$want"; then
    echo "!! No SKILL.md found in '$slug'${want:+ matching '$want'} (skipping)"
  fi
  rm -rf "$tmp"
}

# Fetch one git repo (any host) and seed every SKILL.md dir it contains.
fetch_git_repo() {
  local url="$1" tmp
  echo "=== Cloning '$url' ==="
  tmp=$(mktemp -d)
  if ! git clone --depth 1 --quiet "$url" "$tmp/repo" 2>/dev/null; then
    echo "!! Clone failed for '$url' (skipping)"
    rm -rf "$tmp"
    return 0
  fi
  if ! seed_repo_tree "$tmp/repo"; then
    echo "!! No SKILL.md found in '$url' (skipping)"
  fi
  rm -rf "$tmp"
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

# Opt-in: fetch named skills from the skills.sh registry (resolves to GitHub).
if [ -n "$SEED_SKILLS_SH" ]; then
  echo "Fetching skills from skills.sh: $SEED_SKILLS_SH"
  IFS=',' read -ra _sh_entries <<< "$SEED_SKILLS_SH"
  for entry in "${_sh_entries[@]}"; do
    entry="$(echo "$entry" | xargs)" # trim surrounding whitespace
    [ -n "$entry" ] || continue
    fetch_skills_sh_entry "$entry"
  done
fi

# Opt-in: fetch skills from arbitrary git repos.
if [ -n "$SEED_FROM_REPO" ]; then
  echo "Fetching skills from git repos: $SEED_FROM_REPO"
  IFS=',' read -ra _repo_urls <<< "$SEED_FROM_REPO"
  for url in "${_repo_urls[@]}"; do
    url="$(echo "$url" | xargs)"
    [ -n "$url" ] || continue
    fetch_git_repo "$url"
  done
fi

echo "Done!"
