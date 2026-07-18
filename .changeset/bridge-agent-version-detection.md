---
"@getoma/cli": patch
---

Bridge daemon now reports each detected ACP agent's self-reported version
(best-effort `--version` probe of the wrapped upstream binary) in the runtime
`hello` manifest, so the Console can show "claude-acp (claude) v1.9.0". Probes
run in parallel with a short timeout and fail soft — an unknown version just
omits the field, never blocks the heartbeat.
