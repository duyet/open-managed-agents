# oma-runtime-claude-agent-sdk — sandbox image for agents that use
# `harness: "claude-agent-sdk"` (see apps/agent/src/harness/claude-agent-sdk-loop.ts).
#
# IMPORTANT: this is byte-for-byte the base toolset image. The Claude Agent
# SDK's `query()` spawns Claude Code's CLI as a subprocess on the platform
# host (apps/main-node — see the module-level jsdoc in
# claude-agent-sdk-loop.ts for why), NOT inside the sandbox. Tool calls the
# CLI makes (bash/read/write/edit/glob/grep) are bridged into the SAME
# sandbox every other harness uses via an in-process MCP server. There is
# nothing claude-agent-sdk-specific for the sandbox to pre-install.
#
# This Dockerfile exists as a named, buildable target (`oma-runtime-
# claude-agent-sdk`) so environments can pin to it explicitly and diverge
# later if the CLI ever needs sandbox-side tooling. Until then, treat it as
# an alias for oma-runtime-base.
FROM oma-runtime-base:latest
