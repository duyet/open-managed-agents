# oma-runtime-coding-agent-openai-compat — sandbox image for agents whose
# model runs through the OpenAI-compatible wire format ("oai" /
# "oai-compatible" ApiCompat in apps/agent/src/harness/provider.ts) — e.g.
# xAI Grok, DeepSeek, Groq, or any /v1/chat/completions gateway, addressed
# via a Model Card. See examples/grok-coding-agent/.
#
# Like docker/claude-agent-sdk, this is byte-for-byte the base toolset
# image: the model call (whichever wire format) always happens on the
# platform side (apps/agent / apps/main-node), never inside the sandbox —
# only bash/read/write/edit/glob/grep tool execution happens here, and
# those tools don't care which model or wire format is driving them.
#
# Named as its own buildable target so environments can pin to it
# explicitly and diverge later (e.g. a provider-specific CLI tool some
# coding agent expects pre-installed).
FROM oma-runtime-base:latest
