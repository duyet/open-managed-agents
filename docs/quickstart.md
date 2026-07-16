# oma Quickstart (CLI)

Get oma running locally in under 5 minutes.

## Prerequisites

- **Node.js 22+** — `node --version` should show v22 or higher
- **pnpm 9+** — `npm i -g pnpm` if you don't have it
- **Docker** — `docker compose version` should work

## 1. Clone

```bash
git clone https://github.com/duyet/oma.git
cd oma
```

## 2. Configure

```bash
cp .env.example .env

# Generate required secrets
echo "BETTER_AUTH_SECRET=$(openssl rand -hex 32)" >> .env
echo "PLATFORM_ROOT_SECRET=$(openssl rand -base64 32)" >> .env
```

Edit `.env` and set your API key:

```bash
# .env
API_KEY=my-dev-key
```

## 3. Launch

```bash
docker compose up -d
```

Verify it's running:

```bash
curl localhost:8787/health
```

Expected: `{"status":"ok","backends":{"db":"sqlite"},"version":"0.1.0"}`

## 4. Create an agent

```bash
BASE=http://localhost:8787
KEY=my-dev-key

AID=$(curl -s -X POST $BASE/v1/agents \
  -H "x-api-key: $KEY" \
  -H 'content-type: application/json' \
  -d '{
    "name":"hello",
    "model":"claude-sonnet-4-6",
    "system":"Say hello briefly.",
    "tools":[]
  }' | jq -r .id)
echo "Agent: $AID"
```

## 5. Start a session

```bash
SID=$(curl -s -X POST $BASE/v1/sessions \
  -H "x-api-key: $KEY" \
  -H 'content-type: application/json' \
  -d "{\"agent\":\"$AID\"}" | jq -r .id)
echo "Session: $SID"
```

## 6. Send a message (streaming)

```bash
curl -N -X POST $BASE/v1/sessions/$SID/messages \
  -H "x-api-key: $KEY" \
  -H 'content-type: application/json' \
  -d '{"content":"Hello! What tools do you have?"}'
```

You'll see SSE events streaming the model's reply.

## 7. Open the Console

Browse to **http://localhost:8787** and:
1. Add a **Model Card** (LLM credentials)
2. Create an **Environment** (sandbox config)
3. Build an **Agent** with the visual builder

## Troubleshooting

| Problem | Check |
|---|---|
| `docker compose up` fails | Port 8787 already in use? Try `lsof -i :8787` |
| Health returns 503 | Wait for migrations: `docker compose logs oma --tail=20` |
| 401 on API calls | Does `API_KEY` in `.env` match the header you're sending? |
| Session hangs at "running" | Add `ANTHROPIC_API_KEY` to `.env` or create a Model Card in the Console |
| `jq: command not found` | Install jq: `apt install jq` / `brew install jq` |
| Docker daemon not running | Start Docker Desktop or `systemctl start docker` |

## What's next?

- [Full self-host guide](./deploy/self-host.md)
- [Custom harness examples](./examples/)
- [API reference](https://docs.oma.duyet.net/build/api/)
- [Deploy to Cloudflare](./deploy/cloudflare.md)
