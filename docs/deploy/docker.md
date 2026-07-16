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
    image: ghcr.io/duyet/oma:latest
    environment:
      - DATABASE_URL=postgres://oma:password@postgres:5432/oma
      - NODE_ENV=production
    ports:
      - "8787:8787"
    depends_on:
      - postgres

  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: oma
      POSTGRES_PASSWORD: <secure-password>
      POSTGRES_DB: oma
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports:
      - "5432:5432"

volumes:
  pgdata:
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BETTER_AUTH_SECRET` | Yes | Signs Console sessions (32 hex bytes) |
| `PLATFORM_ROOT_SECRET` | Yes | Encrypts credentials (base64, 32 bytes) |
| `API_KEY` | Yes | API auth key |
| `DATABASE_URL` | No | Postgres URL (default: SQLite) |
| `ANTHROPIC_API_KEY` | No | LLM provider key (or use Model Cards) |

## Sandbox Tuning

Edit `.env` to configure sandbox resources:

```bash
# Memory limit per sandbox container (default: 512m)
SANDBOX_MEMORY_LIMIT=1g

# CPU limit per sandbox (default: 1)
SANDBOX_CPU_LIMIT=2

# Max sandbox runtime in seconds (default: 3600)
SANDBOX_TIMEOUT=7200

# Sandbox idle timeout before pause (seconds)
SANDBOX_IDLE_TIMEOUT=300
```

## Health Checks

```bash
# API health
curl localhost:8787/health

# Postgres connectivity
curl localhost:8787/health/db

# Sandbox status
curl localhost:8787/health/sandbox
```

## Production Checklist

- [ ] Use Postgres (not SQLite)
- [ ] Set strong secrets (32+ bytes random)
- [ ] Configure reverse proxy (nginx/Caddy) with TLS
- [ ] Set up log rotation
- [ ] Configure backups for Postgres
- [ ] Monitor with docker logs + health checks
