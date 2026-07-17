# @getoma/sdk

## 0.1.1

### Patch Changes

- Remove the leftover npm `deprecated` flag inherited from the old @duyet scope — @getoma/sdk is the supported SDK. The API also stays wire-compatible with `@anthropic-ai/sdk` via `baseURL`.

## 0.1.0

### Minor Changes

- Rescoped from `@duyet/oma-sdk` to `@getoma/sdk` and reset versioning to `0.1.0`. Prior history is available on the old package.

## Historical — @duyet/oma-sdk (pre-rescope)

## 1.2.0

### Minor Changes

- 7cc3d50: Add `sessions.pause()` and `sessions.resume()` for sandbox pause/resume.

## 1.1.0

### Minor Changes

- b26c048: Initial publish to npm: `@duyet/oma-sdk` (harness SDK) and `@duyet/oma-cli` (CLI tool).

## 1.0.0

### Major Changes

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

## 0.1.0

### Minor Changes

- be25e78: Add a dreams resource with automatic Managed Agents dreaming beta headers.
