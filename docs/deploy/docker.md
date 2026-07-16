# Docker Deploy Guide

Production Docker deployment with Postgres, custom configuration, and sandbox tuning.

## Requirements

- Docker 24+ and Compose V2
- At least 4 GB RAM allocated to Docker
- Ports 8787 (API), 5432 (Postgres) available

## Postgres Setup

Edit `docker-compose.yml` to use Postgres instead of SQLite:

```yaml
services:
  oma:
    image: ghcr.io/duyet/oma-main-node:latest
    env_file: .env
    environment:
      - DATABASE_URL=postgres://oma:secure_password@postgres:5432/oma
      - NODE_ENV=production
    ports:
      - "8787:8787"
    depends_on:
      postgres:
        condition: service_healthy

  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: oma
      POSTGRES_PASSWORD: secure_password
      POSTGRES_DB: oma
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports:
      - "127.0.0.1:5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U oma"]
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  pgdata:
```

`env_file: .env` supplies `BETTER_AUTH_SECRET`, `PLATFORM_ROOT_SECRET`, and
`API_KEY` (see [Environment Variables](#environment-variables) below) — set
those in `.env` before starting the stack. `secure_password` above is a
placeholder; replace it with your own value in both `DATABASE_URL` and
`POSTGRES_PASSWORD` (they must match). Postgres is bound to
`127.0.0.1:5432` so it's reachable for local administration without
exposing it on every host interface — the `oma` service reaches it over
the Compose network regardless.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BETTER_AUTH_SECRET` | Yes | Signs Console sessions (32 hex bytes) |
| `PLATFORM_ROOT_SECRET` | Yes | Encrypts credentials (base64, 32 bytes) |
| `API_KEY` | Yes | API auth key |
| `DATABASE_URL` | Yes (this guide) | Postgres URL — this guide is specifically the Postgres production path |
| `ANTHROPIC_API_KEY` | No | LLM provider key (or use Model Cards) |

## Sandbox Tuning

Sandbox resource limits are not global docker-compose settings — they're
adapter-specific. The default `subprocess` sandbox adapter has no
memory/CPU knobs. If you switch to the LiteBox (Firecracker micro-VM)
adapter, tune it via `.env`:

```bash
SANDBOX_PROVIDER=litebox
LITEBOX_MEMORY_MIB=512
LITEBOX_CPUS=2
```

## Health Checks

```bash
curl localhost:8787/health
```

## Production Checklist

- [ ] Use Postgres (not SQLite)
- [ ] Set strong secrets (32+ bytes random)
- [ ] Configure reverse proxy (nginx/Caddy) with TLS
- [ ] Set up log rotation
- [ ] Configure backups for Postgres
- [ ] Monitor with docker logs + health checks
