#!/bin/sh
# Registers the agent, creates a session, and sends one message.
# Requires OMA_BASE_URL and OMA_API_KEY. Optionally OMA_ENV_ID (an existing
# environment id); otherwise pass one via --env.
set -eu

: "${OMA_BASE_URL:?set OMA_BASE_URL, e.g. https://your-instance}"
: "${OMA_API_KEY:?set OMA_API_KEY}"
: "${OMA_ENV_ID:?set OMA_ENV_ID to an existing environment id (oma envs list)}"

DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Creating agent..."
AGENT_ID=$(curl -sf "$OMA_BASE_URL/v1/agents" \
  -H "x-api-key: $OMA_API_KEY" -H "content-type: application/json" \
  -d @"$DIR/agent.json" | tr -d '\n' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
echo "Agent: $AGENT_ID"

echo "Creating session..."
SESSION_ID=$(curl -sf "$OMA_BASE_URL/v1/sessions" \
  -H "x-api-key: $OMA_API_KEY" -H "content-type: application/json" \
  -d "{\"agent\": \"$AGENT_ID\", \"environment_id\": \"$OMA_ENV_ID\", \"title\": \"flue example\"}" \
  | tr -d '\n' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
echo "Session: $SESSION_ID"

echo "Sending message..."
curl -sf "$OMA_BASE_URL/v1/sessions/$SESSION_ID/events" \
  -H "x-api-key: $OMA_API_KEY" -H "content-type: application/json" \
  -d '{"events":[{"type":"user.message","content":[{"type":"text","text":"List the files in the current directory."}]}]}'

echo
echo "Tail with: curl -N $OMA_BASE_URL/v1/sessions/$SESSION_ID/events/stream -H \"x-api-key: $OMA_API_KEY\""
