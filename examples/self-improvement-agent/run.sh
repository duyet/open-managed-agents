#!/bin/sh
# Registers the self-improvement agent, provisions (or reuses) a vault
# holding an issues-only `gh` credential, creates a session, attaches this
# repo read-only, and sends one message to kick off a scan.
#
# Requires OMA_BASE_URL, OMA_API_KEY, OMA_ENV_ID.
#
# Credential handling (pick one):
#   - Set OMA_VAULT_ID to an existing vault id that already holds a
#     `cap_cli` credential with cli_id "gh" (recommended for scheduled/cron
#     runs — create it once, see README.md, then reuse the id).
#   - Or set GH_ISSUES_TOKEN (a fine-grained GitHub PAT scoped to
#     Issues: read/write, Actions: read, Contents: read, Metadata: read —
#     NOT Contents: write, NOT Pull requests: write) and this script mints a
#     fresh vault + credential for you. The new vault id is printed so you
#     can promote it to OMA_VAULT_ID for subsequent runs instead of minting
#     a new one every time.
#
# Optional: GITHUB_REPO_URL (default: this repo, duyet/open-managed-agents).
set -eu

: "${OMA_BASE_URL:?set OMA_BASE_URL, e.g. https://your-instance}"
: "${OMA_API_KEY:?set OMA_API_KEY}"
: "${OMA_ENV_ID:?set OMA_ENV_ID to an existing environment id (oma envs list)}"
GITHUB_REPO_URL="${GITHUB_REPO_URL:-https://github.com/duyet/open-managed-agents}"
OMA_VAULT_ID="${OMA_VAULT_ID:-}"
GH_ISSUES_TOKEN="${GH_ISSUES_TOKEN:-}"

DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Creating agent..."
AGENT_ID=$(curl -sf "$OMA_BASE_URL/v1/agents" \
  -H "x-api-key: $OMA_API_KEY" -H "content-type: application/json" \
  -d @"$DIR/agent.json" | tr -d '\n' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
echo "Agent: $AGENT_ID"

if [ -z "$OMA_VAULT_ID" ]; then
  : "${GH_ISSUES_TOKEN:?set OMA_VAULT_ID (existing vault) or GH_ISSUES_TOKEN (mint a new one) — see README.md}"

  echo "Creating vault..."
  OMA_VAULT_ID=$(curl -sf "$OMA_BASE_URL/v1/vaults" \
    -H "x-api-key: $OMA_API_KEY" -H "content-type: application/json" \
    -d '{"name": "self-improvement-agent-vault"}' \
    | tr -d '\n' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
  echo "Vault: $OMA_VAULT_ID (save as OMA_VAULT_ID to reuse — avoids minting a new credential every run)"

  echo "Attaching issues-only gh credential (cap_cli, cli_id=gh)..."
  curl -sf "$OMA_BASE_URL/v1/vaults/$OMA_VAULT_ID/credentials" \
    -H "x-api-key: $OMA_API_KEY" -H "content-type: application/json" \
    -d "{\"display_name\": \"gh (issues-only)\", \"auth\": {\"type\": \"cap_cli\", \"cli_id\": \"gh\", \"token\": \"$GH_ISSUES_TOKEN\"}}" \
    > /dev/null
fi

echo "Creating session..."
SESSION_ID=$(curl -sf "$OMA_BASE_URL/v1/sessions" \
  -H "x-api-key: $OMA_API_KEY" -H "content-type: application/json" \
  -d "{\"agent\": \"$AGENT_ID\", \"environment_id\": \"$OMA_ENV_ID\", \"vault_ids\": [\"$OMA_VAULT_ID\"], \"title\": \"self-improvement scan\"}" \
  | tr -d '\n' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
echo "Session: $SESSION_ID"

# Attach this repo read-only so `pnpm typecheck`/`pnpm test` have something
# to run against. No credential_id — this is a public repo clone, and
# "access": "read_only" documents intent even though the gh CLI's actual
# push-prevention comes from the credential scope above, not this flag.
echo "Attaching GitHub repository resource (read-only)..."
curl -sf "$OMA_BASE_URL/v1/sessions/$SESSION_ID/resources" \
  -H "x-api-key: $OMA_API_KEY" -H "content-type: application/json" \
  -d "{\"type\": \"github_repository\", \"repo_url\": \"$GITHUB_REPO_URL\", \"checkout\": {\"type\": \"branch\", \"name\": \"main\"}, \"access\": \"read_only\"}"

echo
echo "Sending message..."
curl -sf "$OMA_BASE_URL/v1/sessions/$SESSION_ID/events" \
  -H "x-api-key: $OMA_API_KEY" -H "content-type: application/json" \
  -d '{"events":[{"type":"user.message","content":[{"type":"text","text":"Run your scan procedure now."}]}]}'

echo
echo "Tail with: curl -N $OMA_BASE_URL/v1/sessions/$SESSION_ID/events/stream -H \"x-api-key: $OMA_API_KEY\""
