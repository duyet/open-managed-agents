# Cloudflare Deploy Guide

Production Cloudflare deployment with custom domains, OAuth apps, and monitoring.

## Prerequisites

- Node.js 22+, pnpm 10+
- Cloudflare Workers Paid plan ($5/mo)
- wrangler CLI logged in
- Anthropic API key (or compatible provider)

## Quick Deploy

```bash
git clone https://github.com/duyet/oma.git
cd oma
pnpm install
npx wrangler login
./scripts/setup-cf.sh
```

## Custom Domain

Edit `apps/main/wrangler.jsonc`, `apps/agent/wrangler.jsonc`, and `apps/integrations/wrangler.jsonc`:

```jsonc
"routes": [
  { "pattern": "app.yourdomain.com", "custom_domain": true }
]
```

Redeploy:

```bash
npx wrangler deploy --config apps/main/wrangler.jsonc
npx wrangler deploy --config apps/agent/wrangler.jsonc
npx wrangler deploy --config apps/integrations/wrangler.jsonc
```

DNS records auto-create on first deploy (cert provisioning ~1 min).

## OAuth Apps

### GitHub OAuth

1. Create OAuth app at GitHub Settings → Developer settings → OAuth Apps
2. Set callback URL to `https://your-domain.com/api/oauth/github/callback`
3. Set secrets:

```bash
npx wrangler secret put GITHUB_CLIENT_ID --config apps/integrations/wrangler.jsonc
npx wrangler secret put GITHUB_CLIENT_SECRET --config apps/integrations/wrangler.jsonc
```

### Slack OAuth

Same pattern — see [OAuth apps guide](../self-host/oauth-apps.mdx) for full details.

## Monitoring

Workers dashboards are available in the Cloudflare Dashboard:
- **Main worker**: Request count, duration, errors
- **Agent worker**: Session metrics, tool usage
- **Durable Objects**: Storage, requests

Enable logging:

```bash
npx wrangler tail --config apps/main/wrangler.jsonc
```

## Architecture

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Console UI  │────►│  Main Worker │────►│ Agent Worker │
│  (CF Workers)│     │  (API + Auth)│     │  (Sandbox)   │
└──────────────┘     └──────┬───────┘     └──────────────┘
                            │
                    ┌───────┴───────┐
                    │  Durable Objs │
                    │  + R2 + D1    │
                    └───────────────┘
```

## Cost Estimates

| Resource | Cost (approx) |
|----------|--------------|
| Workers Paid plan | $5/mo |
| Durable Objects | ~$2-10/mo (usage dependent) |
| R2 storage | ~$0.015/GB/mo |
| D1 database | ~$0.001/million reads |
| **Total** | **~$10-20/mo** |
