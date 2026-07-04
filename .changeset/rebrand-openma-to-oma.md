---
"@duyet/oma-sdk": major
"@duyet/oma-cli": minor
---

Finish the `openma` → `oma` rebrand in the public SDK and CLI surfaces.

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
