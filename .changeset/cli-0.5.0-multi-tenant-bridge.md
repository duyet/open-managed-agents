---
"@openma/cli": minor
---

`oma bridge` daemon now serves multiple tenants from a single process.
One daemon is authorized for every workspace the user is a member of;
each spawned ACP child gets the per-tenant `oma_*` key matching the
session's workspace.

- `oma bridge setup` requests the multi-tenant `/exchange` shape and
  writes a `CredentialsV2` file (`{v:2, tenants:[…], …}`). Old v1
  creds files (`agentApiKey` at the top level) auto-migrate on next
  daemon start — calls `GET /agents/runtime/me` to pull the tenant
  list, falls back to a placeholder workspace if the server is
  unreachable so the daemon still runs offline.
- `oma bridge refresh` (new) re-syncs the daemon's credentials with
  the user's current memberships. Adds keys for new workspaces, soft-
  revokes keys for removed ones, then `SIGHUP`s the running daemon
  so the change takes effect without a restart.
- `SessionManager` looks up the right `oma_*` key per session by the
  inbound `session.start`'s `tenant_id`. Every outbound message the
  daemon sends carries `tenant_id` so the server can validate it
  against the runtime's authorized set.

Backward-compatible: v1 daemons keep working against the new server
shape (server returns the legacy `{runtime_id, token, agent_api_key}`
when the request doesn't set `multi_tenant: true`). The workaround
for multi-tenant — running multiple `OMA_PROFILE=…` daemons side by
side — still works for separate server environments.
