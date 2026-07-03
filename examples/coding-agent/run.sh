#!/bin/sh
# Registers the agent, creates a session, attaches a GitHub repo resource,
# and sends one message.
#
# Requires OMA_BASE_URL, OMA_API_KEY, OMA_ENV_ID.
# Optionally GITHUB_REPO_URL (default: https://github.com/octocat/Hello-World)
# and GITHUB_CREDENTIAL_ID (a vault credential id for private repos).
set -eu

: "${OMA_BASE_URL:?set OMA_BASE_URL, e.g. https://your-instance}"
: "${OMA_API_KEY:?set OMA_API_KEY}"
: "${OMA_ENV_ID:?set OMA_ENV_ID to an existing environment id (oma envs list)}"
GITHUB_REPO_URL="${GITHUB_REPO_URL:-https://github.com/octocat/Hello-World}"

DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Creating agent..."
AGENT_ID=$(curl -sf "$OMA_BASE_URL/v1/agents" \
  -H "x-api-key: $OMA_API_KEY" -H "content-type: application/json" \
  -d @"$DIR/agent.json" | tr -d '\n' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
echo "Agent: $AGENT_ID"

echo "Creating session..."
SESSION_ID=$(curl -sf "$OMA_BASE_URL/v1/sessions" \
  -H "x-api-key: $OMA_API_KEY" -H "content-type: application/json" \
  -d "{\"agent\": \"$AGENT_ID\", \"environment_id\": \"$OMA_ENV_ID\", \"title\": \"coding-agent example\"}" \
  | tr -d '\n' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
echo "Session: $SESSION_ID"

# Attach a GitHub repo AFTER session creation, via the resources endpoint —
# NOT as part of the agent config. Add "credential_id" for private repos.
echo "Attaching GitHub repository resource..."
curl -sf "$OMA_BASE_URL/v1/sessions/$SESSION_ID/resources" \
  -H "x-api-key: $OMA_API_KEY" -H "content-type: application/json" \
  -d "{\"type\": \"github_repository\", \"repo_url\": \"$GITHUB_REPO_URL\", \"checkout\": {\"type\": \"branch\", \"name\": \"main\"}, \"access\": \"read_write\"}"

echo
echo "Sending message..."
curl -sf "$OMA_BASE_URL/v1/sessions/$SESSION_ID/events" \
  -H "x-api-key: $OMA_API_KEY" -H "content-type: application/json" \
  -d '{"events":[{"type":"user.message","content":[{"type":"text","text":"Summarize the repository structure."}]}]}'

echo
echo "Tail with: curl -N $OMA_BASE_URL/v1/sessions/$SESSION_ID/events/stream -H \"x-api-key: $OMA_API_KEY\""
