# @duyet/oma-cli

## 0.6.0

### Minor Changes

- 87809ed: Finish the `openma` → `oma` rebrand in the public SDK and CLI surfaces.
  - `@duyet/oma-sdk`: renamed the exported `OpenMA` class to `Oma` and
    `OpenMAError` to `OmaError` (breaking — update imports and
    `instanceof` checks). The package is already deprecated in favor of
    `@anthropic-ai/sdk` pointed at the wire-compatible API.
  - `@duyet/oma-cli`: package description/keywords and the HTTP
    `user-agent` string now say `oma`/`OMA-CLI` instead of
    `openma`/`OpenManagedAgents-CLI`. The bridge daemon's launchd/systemd
    service label changed from `dev.openma.bridge` to `dev.oma.bridge`
    (already-installed daemons keep running under the old label until
    the user re-runs `oma bridge setup`, which re-registers under the
    new one — self-healing, no manual cleanup required).

## 0.5.0

### Minor Changes

- [#103](https://github.com/duyet/oma/pull/103) [`85c2e1c`](https://github.com/duyet/oma/commit/85c2e1c359f774a3dbafcc45a6e7875ebba55ff2) Thanks [@hrhrng](https://github.com/hrhrng)! - `oma bridge` daemon now serves multiple tenants from a single process.
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

### Patch Changes

- [`31f7fbf`](https://github.com/duyet/oma/commit/31f7fbf67305f44831a379d9149bcf0c6a8d9c00) Thanks [@hrhrng](https://github.com/hrhrng)! - `oma bridge setup` now exits cleanly after "Done." instead of hanging
  for ~5 minutes on idle keep-alive HTTP sockets from the registry CDN
  fetch and the runtime-token probe. Daemon was already started by
  launchd / systemd / Task Scheduler — only the foreground setup process
  itself was waiting on the undici dispatcher to time out its sockets.
  Force-exits at end of runSetup, matching how npm / pnpm / gh handle
  the same constraint in their CLI commands.

  Adds an opt-in `OMA_DEBUG_HANDLES=1` env var that prints active
  handles + requests every 2s — useful for diagnosing future "process
  won't exit" regressions without redeploying.

## 0.4.1

### Patch Changes

- [#41](https://github.com/duyet/oma/pull/41) [`e370a4a`](https://github.com/duyet/oma/commit/e370a4ab550ca18a37e27761695fb9bbd2e8bdb7) Thanks [@hrhrng](https://github.com/hrhrng)! - `oma bridge setup` now exits cleanly after "Done." instead of hanging
  for ~5 minutes on idle keep-alive HTTP sockets from the registry CDN
  fetch and the runtime-token probe. Daemon was already started by
  launchd / systemd / Task Scheduler — only the foreground setup process
  itself was waiting on the undici dispatcher to time out its sockets.
  Force-exits at end of runSetup, matching how npm / pnpm / gh handle
  the same constraint in their CLI commands.

  Adds an opt-in `OMA_DEBUG_HANDLES=1` env var that prints active
  handles + requests every 2s — useful for diagnosing future "process
  won't exit" regressions without redeploying.

## 0.4.0

### Minor Changes

- [`4df9a0e`](https://github.com/duyet/oma/commit/4df9a0e677eb1712688134fc140edb6d0db3969a) Thanks [@hrhrng](https://github.com/hrhrng)! - Bridge: expand local ACP agent support to the full official registry,
  add cross-platform service install (launchd / systemd / Task Scheduler,
  all no-admin), and wire end-to-end conversation recovery so daemon
  restarts no longer drop context. `oma bridge setup` is now the single
  command on every platform — installs the system service, starts the
  daemon, and audits + offers ACP wrappers for install (npm packages or
  GitHub release tarballs). Includes `OMA_PROFILE` for prod/staging
  side-by-side daemons (default behavior unchanged for current users).

  Fixes a multi-profile bug where the launchd-spawned daemon silently
  dropped `OMA_PROFILE` and read the default profile's credentials,
  causing the "wrong" daemon to compete for the WS attach slot.

## 0.3.2

### Patch Changes

- [`018b647`](https://github.com/duyet/oma/commit/018b647536eb5d1398510fcc37f6c65447a801fd) Thanks [@hrhrng](https://github.com/hrhrng)! - Add Bridge subcommand section to top-level `oma` help so `setup`, `daemon`,
  `status`, `uninstall` are discoverable without grepping or guessing.
