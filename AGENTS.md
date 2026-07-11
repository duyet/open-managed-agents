# Agents Guide

This document covers the core concepts, lifecycle, and configuration of agents in Open Managed Agents.

---

## Core Concepts

Open Managed Agents is built around a **meta-harness** architecture with four key abstractions:

### Agent

An **agent** is a configuration object that defines _what_ an AI assistant can do. It specifies the model, system prompt, available tools, skills, and optional connections to other agents or MCP servers.

Agents are versioned — every update creates a new version. Sessions bind to a specific agent version at creation time.

### Session

A **session** is a running conversation between a user and an agent. It owns an append-only **event log** stored in a Durable Object backed by SQLite. Sessions are the unit of state — agents themselves are stateless configurations.

Sessions can be streamed in real-time via SSE, resumed after crashes, and archived when complete.

### Environment

An **environment** defines the execution sandbox — what packages are installed, what networking is allowed, and what container image to use. Environments are reusable across sessions and agents.

### Vault

A **vault** is a secure credential store. Credentials in vaults are **never exposed to sandboxes** — they're injected via an outbound proxy that intercepts HTTP requests and adds authentication headers transparently.

---

## Agent Lifecycle

```
                    ┌──────────┐
                    │  Create   │  POST /v1/agents
                    └────┬─────┘
                         │
                    ┌────▼─────┐
              ┌────►│  Active   │◄────┐
              │     └────┬─────┘     │
              │          │           │
         ┌────┴───┐ ┌───▼────┐ ┌───┴─────┐
         │ Update  │ │ Archive│ │ Sessions│
         │ (new    │ │        │ │ use it  │
         │ version)│ └───┬────┘ └─────────┘
         └─────────┘     │
                    ┌────▼─────┐
                    │ Archived  │
                    └──────────┘
```

1. **Create** — `POST /v1/agents` with name, model, system prompt, and tools
2. **Use** — Create sessions referencing the agent by ID
3. **Update** — `PUT /v1/agents/:id` creates a new version; existing sessions keep their original version
4. **Archive** — `POST /v1/agents/:id/archive` soft-deletes the agent

---

## Agent Configuration

### Minimal Agent

```json
{
  "name": "Assistant",
  "model": "claude-sonnet-4-6",
  "system": "You are a helpful assistant.",
  "tools": [{ "type": "agent_toolset_20260401" }]
}
```

### Full Configuration

```json
{
  "name": "Full-Stack Developer",
  "description": "A coding agent with access to tools, skills, and external services.",
  "model": "claude-sonnet-4-6",
  "system": "You are an expert full-stack developer. Write clean, tested code.",
  "tools": [
    {
      "type": "agent_toolset_20260401",
      "default_config": { "enabled": true },
      "configs": [
        { "name": "web_search", "enabled": false }
      ]
    },
    {
      "type": "custom",
      "name": "deploy",
      "description": "Deploy the application to production",
      "input_schema": {
        "type": "object",
        "properties": {
          "environment": { "type": "string", "enum": ["staging", "production"] }
        },
        "required": ["environment"]
      }
    }
  ],
  "mcp_servers": [
    { "name": "github", "type": "url", "url": "https://mcp.github.com/sse" }
  ],
  "skills": [
    { "skill_id": "skill_xxx", "type": "prompt" }
  ],
  "callable_agents": [
    { "type": "agent", "id": "agent_yyy" }
  ],
  "model_card_id": "mc_xxx",
  "aux_model": "claude-haiku-4-5",
  "harness": "default",
  "metadata": {
    "team": "platform",
    "owner": "alice"
  }
}
```

### Configuration Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | Yes | Display name for the agent |
| `description` | string | No | Human-readable description |
| `model` | string or object | Yes | Model identifier (e.g. `"claude-sonnet-4-6"`) or `{ id, speed }` |
| `system` | string | Yes | System prompt — defines the agent's behavior and persona |
| `tools` | array | No | Tool configurations (toolsets, custom tools) |
| `mcp_servers` | array | No | External MCP server connections |
| `skills` | array | No | Skill references to mount into the sandbox |
| `callable_agents` | array | No | Other agents this agent can delegate to |
| `max_parallel_subagents` | number | No | Concurrency cap for `call_agents_parallel` (default 5, hard ceiling 10) |
| `model_card_id` | string | No | Reference to a model card for custom provider config |
| `aux_model` | string or object | No | Auxiliary model used by tools for in-process LLM work (e.g. `web_fetch` page summarization). Same shape as `model`. When unset, tools that would benefit from summarization fall back to returning raw content. |
| `aux_model_card_id` | string | No | Companion to `aux_model` — explicit model card binding when needed |
| `harness` | string | No | Harness implementation to use (default: `"default"`) |
| `metadata` | object | No | Arbitrary key-value metadata |

See [`examples/`](examples/) for copy-paste-ready agent and environment
configs (coding assistant, data analyst, research agent, plus full harness
demos with pre-built Docker images).

---

## Tools

### Built-in Toolset

The `agent_toolset_20260401` provides 8 tools designed for general-purpose agent work:

| Tool | Description | Key Behaviors |
|---|---|---|
| **bash** | Execute shell commands | 2min default timeout, 10min max. Auto-backgrounds long-running processes. SIGTERM on timeout. |
| **read** | Read files | Returns file content with line numbers. Handles binary detection. |
| **write** | Write files | Creates parent directories automatically. |
| **edit** | String replacement | Surgical find-and-replace. Fails if `old_str` not found or ambiguous. |
| **glob** | File search | Pattern matching (e.g. `**/*.ts`). Returns sorted file list. |
| **grep** | Content search | Regex search across files. Returns matching lines with context. |
| **web_fetch** | URL → markdown | Fetches a URL, converts HTML/PDF/DOCX/etc. to markdown via Workers AI `env.AI.toMarkdown()`. When `agent.aux_model` is set, large pages (>5KB) are summarized by the aux model and the full markdown is offloaded to `/workspace/.web/<sha>.md` (readable via the `read` tool with offset/limit). Falls back to raw curl with an explicit warning if extraction fails. |
| **web_search** | Web search | Search via Tavily API. Requires `TAVILY_API_KEY`. |

### Tool Configuration

Enable or disable individual tools:

```json
{
  "type": "agent_toolset_20260401",
  "default_config": { "enabled": false },
  "configs": [
    { "name": "bash", "enabled": true },
    { "name": "read", "enabled": true },
    { "name": "write", "enabled": true },
    { "name": "edit", "enabled": true }
  ]
}
```

Set permission policies:

```json
{
  "type": "agent_toolset_20260401",
  "configs": [
    {
      "name": "bash",
      "enabled": true,
      "permission_policy": { "type": "always_ask" }
    }
  ]
}
```

### Custom Tools

Define tools with JSON Schema input validation. Custom tools pause the session with `stop_reason: { type: "requires_action", action_type: "custom_tool_result" }` and wait for the client to provide the result:

```json
{
  "type": "custom",
  "name": "send_email",
  "description": "Send an email to a user",
  "input_schema": {
    "type": "object",
    "properties": {
      "to": { "type": "string" },
      "subject": { "type": "string" },
      "body": { "type": "string" }
    },
    "required": ["to", "subject", "body"]
  }
}
```

### Derived Tools

These tools are automatically generated based on session configuration:

| Tool | Generated When | Purpose |
|---|---|---|
| `call_agent_*` | `callable_agents` configured | Delegate work to another agent (one at a time, blocks until idle) |
| `call_agents_parallel` | `callable_agents` configured | Fan out to multiple sub-agents concurrently and aggregate their results |
| `mcp_*` | `mcp_servers` configured | Call MCP server tools |

(Memory stores do **not** generate bespoke tools. Each attached store is
mounted at `/mnt/memory/<store_name>/` in the sandbox and the agent uses the
standard file tools — `bash`/`read`/`write`/`edit`/`glob`/`grep` — to access
it. See [Memory Stores](#memory-stores) below.)

---

## Sessions

### Session Lifecycle

```
  POST /v1/sessions          POST /events            Harness completes
         │                        │                        │
    ┌────▼────┐             ┌─────▼─────┐           ┌─────▼─────┐
    │  idle    │────────────►│  running   │──────────►│   idle     │
    └─────────┘             └─────┬─────┘           └───────────┘
                                  │
                            (on crash)
                                  │
                            ┌─────▼─────┐
                            │   idle     │  + session.error event
                            └───────────┘
```

- **idle** — Waiting for user input
- **running** — Harness is actively processing (model calls, tool execution)
- **rescheduled** — Container is being provisioned; will resume automatically
- **terminated** — Session ended (explicit termination or error)

### Sandbox Pause & Resume

Orthogonal to the lifecycle above: `sandbox_status` (`"running"` | `"paused"` |
`"none"`) tracks whether the session's sandbox container is currently
provisioned, independent of `idle`/`running`/`terminated`. Pausing is
reversible — unlike termination — and exists purely to stop paying for an
idle container.

```bash
# Snapshot /workspace and destroy the container. Refuses (409) while a
# turn is in-flight. No-op (200) if already paused.
curl -s -X POST $BASE/v1/sessions/$ID/pause -H "x-api-key: $KEY"
# → {"id": "sess_xxx", "sandbox_status": "paused"}

# Reprovision the container and restore the latest workspace snapshot.
# No-op (200) if not paused.
curl -s -X POST $BASE/v1/sessions/$ID/resume -H "x-api-key: $KEY"
# → {"id": "sess_xxx", "sandbox_status": "running"}
```

Sending a `user.message` to a paused session implicitly resumes it (the
sandbox warms lazily on first use, same as a fresh session) — an explicit
`/resume` call is only needed to pay the cold-start cost up front instead
of on the next message.

### Event Types

Sessions communicate through a typed event log. Events fall into four categories:

**User events** (sent by the client):

| Event | Description |
|---|---|
| `user.message` | User sends a message (text, images, documents) |
| `user.interrupt` | User interrupts a running agent |
| `user.tool_confirmation` | User allows or denies a tool call |
| `user.custom_tool_result` | User provides result for a custom tool |
| `user.define_outcome` | User defines success criteria for evaluation |

**Agent events** (emitted by the harness):

| Event | Description |
|---|---|
| `agent.message` | Agent text response |
| `agent.thinking` | Agent thinking/reasoning |
| `agent.tool_use` | Agent calls a built-in tool |
| `agent.tool_result` | Result from a tool execution |
| `agent.custom_tool_use` | Agent calls a custom tool (pauses session) |
| `agent.mcp_tool_use` | Agent calls an MCP server tool |
| `agent.mcp_tool_result` | Result from an MCP tool |
| `agent.status` | Structured progress heartbeat (`state`, `summary`, `step`, `total_steps`, `blocked_on`) for long-running work. OMA extension — purely observational, excluded from model context. Emitted per model turn by `default`, and on a fixed cadence by the `long-running` harness. |

**Session events** (lifecycle signals):

| Event | Description |
|---|---|
| `session.status_running` | Harness started processing |
| `session.status_idle` | Harness finished; includes `stop_reason` |
| `session.status_rescheduled` | Waiting for container provisioning |
| `session.status_terminated` | Session ended |
| `session.sandbox_paused` | Sandbox snapshotted + destroyed via `POST /pause`. OMA extension. |
| `session.sandbox_resumed` | Sandbox reprovisioned via `POST /resume`. OMA extension. |
| `session.error` | Error occurred (may be retryable) |

**Observability events** (spans):

| Event | Description |
|---|---|
| `span.model_request_start` | Model API call started |
| `span.model_request_end` | Model API call completed (includes token usage) |
| `span.outcome_evaluation_start` | Outcome evaluation began |

### Streaming

Sessions support real-time SSE streaming:

```bash
# SSE stream (recommended for real-time UIs)
curl -N https://your-instance/v1/sessions/{id}/events/stream \
  -H "x-api-key: $KEY"

# JSON polling
curl https://your-instance/v1/sessions/{id}/events \
  -H "x-api-key: $KEY" \
  -H "Accept: application/json"

# Content negotiation
curl https://your-instance/v1/sessions/{id}/events \
  -H "x-api-key: $KEY" \
  -H "Accept: text/event-stream"
```

### Crash Recovery

The event log enables automatic crash recovery:

1. Harness crashes mid-execution
2. SessionDO catches the error, emits `session.error`, returns to `idle`
3. Next `user.message` creates a fresh harness instance
4. New harness reads the full event log, rebuilds context, and continues

No data is lost because events are durably written to SQLite **before** being broadcast.

---

## Environments

Environments define the sandbox where tools execute:

```json
{
  "name": "data-science",
  "config": {
    "type": "cloud",
    "packages": {
      "pip": ["numpy", "pandas", "matplotlib", "scikit-learn"],
      "apt": ["ffmpeg"]
    },
    "networking": {
      "type": "unrestricted"
    }
  }
}
```

### Package Managers

| Manager | Field | Example |
|---|---|---|
| Python (pip) | `packages.pip` | `["numpy", "pandas"]` |
| Node.js (npm) | `packages.npm` | `["lodash", "express"]` |
| System (apt) | `packages.apt` | `["ffmpeg", "imagemagick"]` |
| Rust (cargo) | `packages.cargo` | `["ripgrep"]` |
| Ruby (gem) | `packages.gem` | `["rails"]` |
| Go | `packages.go` | `["golang.org/x/tools/..."]` |

### Networking

```json
{
  "networking": {
    "type": "limited",
    "allowed_hosts": ["api.github.com", "registry.npmjs.org"],
    "allow_mcp_servers": true,
    "allow_package_managers": true
  }
}
```

### Sandbox Provider on the Cloudflare Deployment

An environment's `config.sandbox_provider` (or legacy `config.type`) selects
the sandbox adapter. On self-host Node, `apps/main-node` resolves it through
the full `SandboxProviderRegistry` (`packages/sandbox`) — every adapter is
available there. On the **Cloudflare deployment**, only a subset works,
because a Worker is a single-file V8 isolate with no filesystem, no
`child_process`, and no runtime dynamic-import resolution:

| `sandbox_provider` | Cloudflare behavior |
|---|---|
| absent / `"cloud"` / unrecognized id | CloudflareSandbox (unchanged default — Cloudflare Containers) |
| `"boxrun"` | Works — talks to a remote BoxRun (`boxlite serve`) control plane over plain `fetch`, no driver SDK. Requires `BOXRUN_URL` (`wrangler secret put`); missing it fails clearly with a `session.error` rather than silently falling back. |
| `"k8s-remote"` | Works — talks to an in-cluster **k8s-sandbox-gateway** over plain `fetch` (boxrun-shaped HTTP API: create / exec+SSE / files-as-tar / destroy), no Node builtins. Requires `K8S_SANDBOX_GATEWAY_URL` (`wrangler secret put`); missing it fails clearly with a `session.error` (parity with boxrun's missing-`BOXRUN_URL`). The self-host Node path keeps using the direct `KubernetesSandboxExecutor` (in-cluster, unchanged). **Limitation:** memory-store / session-outputs bind-mounts aren't available over the HTTP tar API — like boxrun, those mounts aren't exposed by the gateway. |
| `"daytona"` / `"e2b"` | Outbound-HTTP-only in principle (no Node builtins), but **not yet wired on Cloudflare** — their driver SDKs (`@daytonaio/sdk`, `e2b`) aren't bundled into the Worker. Selecting either fails clearly with a `session.error`; both already work on the self-host Node runtime. |
| `"subprocess"` / `"litebox"` / `"k8s"` | Node-only (child_process, a native micro-VM binding, or local kubeconfig/filesystem access) — cannot run in a Worker at all. Selecting one fails clearly with a `session.error` explaining to use the self-host runtime instead. |

See `classifyCfSandboxProvider` (`packages/sandbox/src/provider-config.ts`)
for the classification and `resolveCfSandbox`
(`apps/agent/src/runtime/sandbox.ts`) for the resolution + error path.

### Environment Status

Environments go through a build process:

- **building** — Container image is being prepared with requested packages
- **ready** — Environment is available for use
- **error** — Build failed (check logs)

---

## Vaults & Credentials

Vaults provide secure credential management with a key design principle: **credentials never enter the sandbox**.

```bash
# Create a vault
curl -s $BASE/v1/vaults \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"name": "production-secrets"}'

# Add a GitHub token
curl -s $BASE/v1/vaults/$VAULT_ID/credentials \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{
    "display_name": "GitHub Token",
    "auth": {
      "type": "static_bearer",
      "mcp_server_url": "https://api.github.com",
      "token": "ghp_xxx"
    }
  }'
```

### Credential Types

| Type | Use Case | Injection Method |
|---|---|---|
| `static_bearer` | API tokens (GitHub, etc.) | `Authorization: Bearer` header on matching URLs |
| `mcp_oauth` | OAuth-authenticated MCP servers | Token refresh + injection via outbound proxy |
| `cap_cli` | CLI tools (gh, aws, kubectl, wrangler, ...) | `Authorization` header injected at the outbound-proxy/network layer for a registered CLI's endpoints (`cap.builtinSpecs`), matched by `cli_id` — replaces the older `command_secret` type, which injected tokens straight into the subprocess env (leaky) |

### How It Works

1. Session is created with `vault_ids`
2. Sandbox makes an HTTP request (e.g., to `api.github.com`)
3. Outbound proxy intercepts the request
4. Proxy matches the URL against vault credentials
5. Proxy injects the appropriate auth header
6. Request reaches the external service with credentials
7. Sandbox never sees the raw token

---

## Memory Stores

Memory stores provide persistent storage for agents across sessions, aligned
with the [Anthropic Managed Agents Memory contract](https://platform.claude.com/docs/en/managed-agents/memory).
Each attached store is mounted into the sandbox at `/mnt/memory/<store_name>/`.
The agent reads and writes it with the **standard file tools**
(`bash` / `read` / `write` / `edit` / `glob` / `grep`) — there are no
bespoke `memory_*` tools.

```bash
# Create a memory store
curl -s $BASE/v1/memory_stores \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"name": "project-knowledge", "description": "Learnings about the codebase"}'

# Attach to a session (Anthropic-aligned `instructions` field, 4096 char cap)
curl -s $BASE/v1/sessions/$SESSION_ID/resources \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"type": "memory_store", "memory_store_id": "ms_xxx",
       "access": "read_write",
       "instructions": "Your project notes. Check before starting any task."}'
```

Then inside the session the agent does:
```bash
ls /mnt/memory/project-knowledge/
cat /mnt/memory/project-knowledge/architecture.md
echo "..." > /mnt/memory/project-knowledge/notes/2026-04-29.md
```

**Storage:** R2 holds the bytes-of-truth (key `<store_id>/<memory_path>`);
D1 holds the index + audit, kept eventually consistent via R2 Event
Notifications → Cloudflare Queue → Consumer in `apps/main`. REST API writes
update the audit row inline (strong-consistent); agent FUSE writes audit
asynchronously (typically <30s). Local dev (`wrangler dev`) does not fire
R2 events — REST writes still audit, agent FUSE writes don't.

**Versioning + rollback:** Every mutation creates an immutable
`memory_versions` row with the content snapshot inline (capped at 100KB).
30-day retention with the most-recent version per memory always preserved.
Rollback = retrieve the desired version's content and write it back via
`memories.update` — produces a new version naturally.

**Redact:** wipes content/path/sha on a prior version, leaving the audit
row. Refuses to redact the live head — write a new version first.

**CAS:** pass `precondition: { type: "content_sha256", content_sha256 }` on
update to refuse stale-write clobbers. Use `precondition: { type: "not_exists" }`
on create to refuse occupied paths.

**CLI:**
```bash
oma memory stores create "User Preferences" --description "Per-user prefs"
oma memory write <store-id> /preferences/formatting.md --from-file local.md
oma memory ls <store-id> --prefix /preferences/
oma memory versions <store-id> --memory-id <mem-id>
oma memory redact <store-id> <version-id>
```

---

## Multi-Agent Delegation

Agents can delegate work to other agents using `callable_agents`:

```json
{
  "name": "Lead Developer",
  "model": "claude-sonnet-4-6",
  "system": "You are a lead developer. Delegate research to the researcher agent.",
  "tools": [{ "type": "agent_toolset_20260401" }],
  "callable_agents": [
    { "type": "agent", "id": "agent_researcher" }
  ]
}
```

This generates a `call_agent_researcher` tool. When invoked, the platform
(`runSubAgent` in `apps/agent/src/runtime/session-do.ts`):

1. Spawns a child **thread** for the target agent — its own message history
   and `sthr_*` id (surfaced as `thread_id`/`session_thread_id`), nested
   inside the parent *session* rather than a separate top-level session
2. Forwards the message
3. Waits for the child to reach `idle`
4. Returns the child's response to the parent

**Sandbox scope:** by default a sub-agent thread shares the parent's
sandbox (same `/workspace`, same files) — the cheap path, and what every
agent config gets today since `environment_id` is unset. A `callable_agents`
roster entry can opt a specific sub-agent into its own sandbox by setting
`environment_id` to a different environment than the parent session's own:

```json
{
  "callable_agents": [
    { "type": "agent", "id": "agent_researcher", "environment_id": "env_isolated" }
  ]
}
```

When set and different from the parent session's `environment_id`, the
platform resolves that environment record and mints a dedicated
`SandboxExecutor` for just that sub-agent's turn, torn down (best-effort
destroy) once the call returns. API-only for now — no Console UI to set it
yet. Known limitations of a dedicated sub-agent sandbox: it starts from an
empty `/workspace` (no restore-from-backup — nothing persists it across
calls), memory-store and session-outputs mounts aren't wired, and its usage
isn't metered into `sandbox_usage`. Vault credential injection (outbound
proxy) IS wired, so authenticated outbound calls still work. If the target
environment record can't be found, the sub-agent falls back to the parent's
sandbox (logged, not surfaced to the caller). If the environment's
`sandbox_provider` is unavailable on this deployment
(`SandboxProviderUnavailableError` — e.g. a node-only provider requested on
the Cloudflare deployment), the fallback is skipped: that sub-agent call
fails outright, the same way any other per-call delegation failure surfaces
(`success: false` from `call_agents_parallel`, or a tool error for the
single-call path) — running the sub-agent on the wrong sandbox silently
would be worse than failing loudly.

### Parallel Delegation

`call_agent_*` tools run one child at a time — the parent blocks until each
child reaches `idle` before the next call can start. When an agent has 1+
entries in `callable_agents`, the platform also generates a
`call_agents_parallel` tool that fans out to several children **concurrently**
(even to the same sub-agent id, called multiple times) and aggregates their
results:

```json
{
  "calls": [
    { "agent_id": "agent_researcher", "message": "Research topic A" },
    { "agent_id": "agent_researcher", "message": "Research topic B" },
    { "agent_id": "agent_writer", "message": "Draft an outline for topic C" }
  ]
}
```

Returns one result per call, each carrying its own status so a single failing
child doesn't lose the others' results:

```json
{
  "results": [
    { "agent_id": "agent_researcher", "success": true, "response": "...", "thread_id": "sthr_..." },
    { "agent_id": "agent_researcher", "success": true, "response": "...", "thread_id": "sthr_..." },
    { "agent_id": "agent_writer", "success": false, "error": "Sub-agent error: ..." }
  ]
}
```

- `thread_id` is the child's `session_thread_id` (same id emitted on
  `session.thread_created`) — use it to deep-link into that child's event log.
- Concurrency is capped — default 5 in-flight children at once, hard ceiling
  10 regardless of config. Requests beyond the cap queue in waves rather than
  being rejected. Lower (or raise, up to the ceiling) the default via the
  agent's `max_parallel_subagents` field.
- A call targeting an `agent_id` not in the agent's `callable_agents` roster
  fails just that entry (`success: false`) without aborting the batch.

---

## Custom Harness

The default harness (`DefaultHarness`) handles most use cases, but you can replace it entirely:

```typescript
import type { HarnessInterface, HarnessContext } from "./harness/interface";
import { generateText } from "ai";
import { resolveModel } from "./harness/provider";

export class DataAnalysisHarness implements HarnessInterface {
  async run(ctx: HarnessContext): Promise<void> {
    const { agent, env, runtime } = ctx;

    // 1. Read conversation history
    const messages = runtime.history.getMessages();

    // 2. Custom context engineering
    //    (e.g., preserve DataFrame outputs, aggressive text compaction)
    const optimized = this.compactForDataWork(messages);

    // 3. Call the model with your strategy
    const result = await generateText({
      model: resolveModel(agent.model, env.ANTHROPIC_API_KEY),
      system: agent.system,
      messages: optimized,
      tools: ctx.tools,      // Pre-built by the platform
      maxSteps: 100,         // Data work needs more steps
    });

    // 4. Broadcast results
    for (const step of result.steps) {
      for (const content of step.content) {
        runtime.broadcast({
          type: "agent.message",
          content: [{ type: "text", text: content.text }],
        });
      }
    }
  }
}
```

Register it:

```typescript
import { registerHarness } from "./harness/registry";
registerHarness("data-analysis", () => new DataAnalysisHarness());
```

Use it:

```json
{ "name": "Data Analyst", "model": "claude-sonnet-4-6", "harness": "data-analysis" }
```

The platform handles everything else — tool construction, skill mounting, sandbox lifecycle, event persistence, crash recovery, and WebSocket broadcasting.

---

## Skills

Skills are reusable prompt fragments and files that get mounted into the sandbox and injected into the system prompt:

```bash
# Create a skill
curl -s $BASE/v1/skills \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{
    "name": "code-review",
    "type": "prompt",
    "content": "When reviewing code, check for: security vulnerabilities, performance issues, error handling gaps, and test coverage."
  }'
```

Attach skills to an agent:

```json
{
  "skills": [
    { "skill_id": "skill_xxx", "type": "prompt" }
  ]
}
```

When a session starts, skills are:
1. Resolved from KV storage
2. Mounted as files in the sandbox (`/home/user/.skills/`)
3. Injected into the system prompt as additional context

---

## Model Configuration

### Direct Model Reference

```json
{ "model": "claude-sonnet-4-6" }
```

### Model with Speed Setting

```json
{ "model": { "id": "claude-sonnet-4-6", "speed": "fast" } }
```

### Model Cards

For custom providers or API configurations, use model cards:

```bash
curl -s $BASE/v1/model_cards \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{
    "name": "GPT-4o via proxy",
    "provider": "openai",
    "model_id": "gpt-4o",
    "base_url": "https://my-proxy.example.com/v1"
  }'
```

Reference in agent config:

```json
{ "model_card_id": "mc_xxx" }
```

Supported providers: `anthropic`, `openai`, `custom`.

### Default Provider Fallback

When an agent's `model` handle matches no Model Card, the Cloudflare
deployment falls back to static env-var secrets, in order:

1. `ANTHROPIC_API_KEY` (+ optional `ANTHROPIC_BASE_URL`) — the long-standing
   default.
2. `ANYROUTER_API_KEY` — routes through [AnyRouter](https://anyrouter.dev),
   an OpenAI-compatible LLM gateway, only when `ANTHROPIC_API_KEY` is unset.
   AnyRouter addresses models as `provider/model` (e.g.
   `anthropic/claude-sonnet-4-6`), so `agent.model` must be set accordingly
   to use this fallback.

An explicit Model Card always wins over both. See
`resolveDefaultProviderCreds` in `apps/agent/src/harness/provider.ts` and
`resolveModelCardCredentials` in `apps/agent/src/runtime/session-do.ts`.

The `claude-agent-sdk` harness (self-host Node only — see
[Custom Harness](#custom-harness)) authenticates its CLI subprocess
independently: `ANTHROPIC_API_KEY`, or `CLAUDE_CODE_OAUTH_TOKEN` (minted via
`claude setup-token`) when that's unset — the CI/CD alternative for
non-interactive deploys.

---

## Session Resources

Attach external resources to a session at runtime:

### Files

```json
{
  "type": "file",
  "file_id": "file_xxx",
  "mount_path": "/home/user/data/input.csv"
}
```

### GitHub Repositories

```json
{
  "type": "github_repository",
  "repo_url": "https://github.com/owner/repo",
  "checkout": { "type": "branch", "name": "main" },
  "credential_id": "cred_xxx",
  "access": "read_write"
}
```

### Memory Stores

```json
{
  "type": "memory_store",
  "memory_store_id": "ms_xxx"
}
```

---

## Outcome Evaluation

Define success criteria and let the platform evaluate whether the agent achieved them:

```json
{
  "events": [{
    "type": "user.define_outcome",
    "description": "The test suite should pass with 100% coverage",
    "rubric": "1. All tests pass (npm test exits 0)\n2. Coverage report shows 100%\n3. No skipped tests",
    "max_iterations": 5
  }]
}
```

The platform will:
1. Run the agent
2. Evaluate the outcome against the rubric
3. If `needs_revision`, provide feedback and re-run
4. Repeat until `satisfied` or `max_iterations_reached`

Events emitted: `span.outcome_evaluation_start`, `session.outcome_evaluated`.

---

## Debugging & Observability

When investigating platform or agent issues, follow this loop. **Do not skip steps.**

```
1. Define Observation
   - What exactly needs to be observed to confirm or deny the hypothesis?
   - Add logs (console.log) at specific points BEFORE deploying
   - Decide what metrics to check: response time, event count, error messages, container status

2. Measure
   - Deploy with logs
   - Collect actual data: wrangler tail, curl, observation scripts
   - Record exact timestamps, counts, error messages

3. Diagnose
   - Compare observation with expectation
   - Match → hypothesis confirmed, proceed with fix
   - Mismatch → new hypothesis, back to step 1
```

**Rules:**
- One change per deploy. Verify before stacking changes.
- Never assume the cause — observe first.
- `wrangler tail <worker-name>` shows real-time Durable Object logs. Use it.
- Read dependency source code (`node_modules/agents/`, `@cloudflare/sandbox`) instead of guessing behavior.

---

## Releasing `@duyet/oma-cli` and `@duyet/oma-sdk`

We use [changesets](https://github.com/changesets/changesets) for the two
public npm packages. Internal `@duyet/oma-*` packages never publish.

**Per PR (only if you touched `packages/cli` or `packages/sdk`):**

```bash
pnpm changeset
# pick package(s) → patch / minor / major → write a one-line changelog
git add .changeset/ && git commit && git push
```

The interactive prompt produces a `.changeset/<random>.md` file. Commit it
along with your code change. PRs that only touch console / workers / docs /
internal packages don't need a changeset.

**After your PR merges:**

1. `release.yml` automatically opens a "Version Packages" PR that bumps
   versions and updates `CHANGELOG.md` based on the accumulated changesets
2. Review the bump + changelog, merge that PR
3. `release.yml` runs again — version-pr job is auto, **publish job needs
   one production-environment approval** (the only manual gate)
4. Packages publish to npm via OIDC trusted publisher (no NPM_TOKEN); tag
   is auto-derived from the version (`-beta.N` → beta tag, plain → latest)

**Prerelease (beta) flow:**

```bash
pnpm changeset pre enter beta   # next bumps become 0.x.y-beta.N → tag=beta
# … work, ship, gather feedback …
pnpm changeset pre exit         # next Version Packages PR rolls to stable
```

Detailed flow + troubleshooting in [`docs/release-process.md`](docs/release-process.md).
The trusted publisher config on npmjs.com must list `release.yml` for both
public packages; without it the publish step 401s.
