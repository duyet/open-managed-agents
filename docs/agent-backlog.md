# Agent Feature Backlog

> Convert these to GitHub issues once Issues are enabled (Settings → Features → Issues).

This is a prioritized backlog of agent-platform features. Each entry references
concrete files/seams in this repo so it can be picked up directly, or split
into GitHub issues later without re-deriving context.

---

## 1. Long-running coding-agent harness with periodic structured status reporting

**Motivation**: Long coding tasks (multi-hour refactors, CI-fix loops) currently
report progress only via free-text `agent.message` events. A manager UI (or a
human babysitting a session) has no structured signal for "what step are we
on / % done / blocked on what" without parsing prose.

**Proposed approach**:
- Add a new harness, e.g. `apps/agent/src/harness/long-running-loop.ts`,
  registered in `apps/agent/src/index.ts` via `registerHarness("long-running", …)`
  alongside `default`, `acp-proxy`, `flue`.
- Implement `HarnessInterface.run` (`apps/agent/src/harness/interface.ts`) with
  an internal step counter/timer that periodically emits a new structured
  event kind (e.g. `agent.status_report` with `{ step, total_steps_estimate,
  summary, blocked_on }`) via `runtime.broadcast` — same append-only event log
  used by every other event, so it's durable and replayable on crash recovery
  (see `apps/agent/src/runtime/session-do.ts`, "Crash Recovery" in `AGENTS.md`).
- Define the new event's shape in `packages/shared/src/...` (wherever
  `SessionEvent` / `agent.*` variants live) so it round-trips through
  `deriveModelContext`/`eventsToMessagesAsync` without polluting model context
  (likely excluded from the model-message projection, similar to how span
  events are handled).
- Reuse `shouldCompact`/`compact` hooks unchanged — status events should be
  cheap enough to not force early compaction, but must be considered in the
  token-estimate heuristic.
- Console: surface the latest `agent.status_report` in the session view
  (`apps/console/src/pages` — check existing session detail page) as a
  progress indicator.

**Acceptance criteria**:
- [ ] New `long-running` harness registered and selectable via `"harness": "long-running"` in agent config
- [ ] Structured status event type added to shared event schema, documented in `AGENTS.md` Event Types table
- [ ] Status events emitted on a fixed cadence (e.g. every N tool calls or T minutes) without breaking prompt-cache byte-determinism of `deriveModelContext`
- [ ] Crash recovery replays status events correctly (no duplicate/missing reports)
- [ ] Console session view renders the latest status report
- [ ] Test: harness emits at least one status event over a multi-step simulated run

---

## 2. Child/parallel sub-agent spawning + result aggregation

**Motivation**: `callable_agents` (see `AGENTS.md` → Multi-Agent Delegation)
today spawns one child session per `call_agent_*` tool call and blocks until
it's idle — sequential, one child at a time. There's no way for a parent
agent to fan out N children in parallel and aggregate their results, which
is needed for research/decomposition-style workflows.

**Proposed approach**:
- Locate the current `call_agent_*` tool generation (search `apps/agent/src`
  for `callable_agents` / `call_agent_` — likely in `harness/tools.ts` and
  the delegate path `ctx.env.delegateToAgent` in `harness/interface.ts`).
- Add a new derived tool, e.g. `call_agents_parallel`, accepting an array of
  `{ agent_id, message }` and internally issuing concurrent
  `delegateToAgent` calls (`Promise.all`), returning an aggregated array of
  child responses (and surfacing partial failures without failing the whole
  tool call).
- Each child session already exists independently in `SessionDO` — no new
  runtime primitive needed, just concurrency at the calling layer plus
  result collection/typing.
- Consider a cap on concurrent children (resource/quota guard) and surface
  per-child session ids in the tool result so the console can deep-link into
  each child's event log.

**Acceptance criteria**:
- [ ] `call_agents_parallel` tool generated when `callable_agents` has 1+ entries (or a new agent config flag opts in)
- [ ] Children run concurrently, not sequentially (verified by timing test)
- [ ] Partial failure in one child doesn't fail the whole tool call — result includes per-child status
- [ ] Concurrency cap configurable/enforced
- [ ] Test covering fan-out + aggregation with 3+ mocked children

---

## 3. Agent run history + summary

**Motivation**: Each session's event log in `SessionDO` (DO-SQLite) is the
source of truth, but there's no cross-session "what has agent X done over
its last N runs" view — useful for a manager dashboard and for the
self-improvement agent (item 6 below).

**Proposed approach**:
- `packages/sessions-store` (and `test/unit/sessions-store-service.test.ts`)
  already indexes sessions; check whether it currently stores anything
  beyond id/status/agent_id/timestamps.
- Add a summary field/table: either (a) compute on-demand by replaying each
  session's event log and extracting the final `agent.message` + tool-call
  count + duration, or (b) persist a lightweight per-session summary row
  (title, outcome, stop_reason, message/tool counts) written by `SessionDO`
  when it transitions to `idle`/`terminated` (`session.status_idle` /
  `session.status_terminated` events, see `AGENTS.md` Event Types).
- Follow the existing pagination convention (`packages/shared/src/pagination.ts`
  — `created_at` + `id`, `(created_at, id) DESC`, opaque cursors) for a new
  `GET /v1/agents/:id/runs` (or similar) list endpoint.

**Acceptance criteria**:
- [ ] Per-session summary persisted (or cheaply derivable) on session completion
- [ ] New paginated endpoint listing an agent's run history, following `packages/shared/src/pagination.ts` conventions
- [ ] Summary includes at minimum: status, duration, tool-call count, stop reason
- [ ] Covered by a `sessions-store` test analogous to `test/unit/sessions-store-service.test.ts`

---

## 4. Kanban board for agent assignment/progress in apps/console

**Motivation**: Operators need a visual way to see which sessions/tasks are
queued, running, blocked (waiting on `requires_action`/tool confirmation), or
done — today the console likely only has list/detail views.

**Proposed approach**:
- New page under `apps/console/src/pages` (check existing session list page
  for the data-fetching pattern / hooks in `apps/console/src/hooks`).
- Columns: **queued** (session created, not yet `running`), **running**
  (`session.status_running`), **blocked** (`stop_reason.type ===
  "requires_action"` — custom tool result or tool confirmation pending),
  **done** (`idle` with no pending action, or `terminated`).
- Derive column placement from existing session status + last event's
  `stop_reason`, rather than inventing new state — reuses the state machine
  already documented in `AGENTS.md` Session Lifecycle.
- Drag-and-drop is optional for v1; a read-only board sourced from item 3's
  run-history endpoint (or the existing sessions list endpoint) covers the
  core need.

**Acceptance criteria**:
- [ ] New console page renders a 4-column board (queued/running/blocked/done)
- [ ] Column membership derived from real session status + stop_reason, no new backend state
- [ ] Board auto-refreshes (poll or SSE, matching existing console session-stream usage)
- [ ] Basic test/story for the board component under `apps/console/src/test`

---

## 5. Notification/tag integrations: GitHub, Slack, Element/Matrix

**Motivation**: Agents and operators need to be notified (or notify humans)
through existing chat/issue-tracker surfaces when a session needs attention,
completes, or is tagged.

**Proposed approach**:
- `packages/github` and `packages/slack` already exist with a consistent
  shape (`api/`, `config.ts`, `oauth/`, `ports.ts`, `provider.ts`,
  `webhook/`, `index.ts`) — this is the template to follow.
- GitHub: extend `packages/github` (or a thin consumer in `apps/main`) to
  post session status updates as issue/PR comments, keyed off
  `session.status_*` events.
- Slack: extend `packages/slack` similarly to post to a configured channel
  on session completion/error (`session.error`, `session.status_terminated`).
- Matrix/Element: new package `packages/matrix`, mirroring `packages/slack`'s
  `ports.ts`/`provider.ts` structure (Matrix Client-Server API for sending
  messages; consider a bot access token + room id config, analogous to
  Slack's bot token + channel). No existing precedent in this repo — treat
  as net-new following the Slack package's file layout for consistency.
- Wire all three behind a common "notification target" concept on agent or
  session config (mirroring how `mcp_servers`/`vault_ids` are attached),
  so a session can declare `notify: [{ type: "slack", channel }, { type:
  "matrix", room_id }]`.

**Acceptance criteria**:
- [ ] `packages/github` supports posting session-status comments to an issue/PR
- [ ] `packages/slack` supports posting session-status messages to a channel
- [ ] New `packages/matrix` package with Matrix send-message support, following the `packages/slack` file layout
- [ ] Common session/agent-level config field to attach notification targets
- [ ] Tests per package following existing `webhook`/`provider` test patterns

---

## 6. Self-improvement agent that scans repo/CI and files new issues automatically

**Motivation**: Given GitHub Issues are currently disabled on this repo, and
generally as a dogfooding use case, an agent that watches CI failures / repo
health and proposes work items would close the loop on autonomous
maintenance (see `agent-loop` skills already present in this environment).

**Proposed approach**:
- Model as a regular OMA agent config (`AGENTS.md` → Agent Configuration)
  with `tools: [{ "type": "agent_toolset_20260401" }]` (bash/read/grep/glob
  are sufficient to run `gh`, `pnpm typecheck`, `pnpm test`) plus a
  `mcp_servers` or `vault_ids` credential scoped to `gh` CLI auth
  (`command_secret` credential type, see AGENTS.md → Credential Types) so it
  can call `gh issue create` (once Issues are re-enabled) or, meanwhile,
  append entries to this same `docs/agent-backlog.md`.
- Schedule it via a cron-triggered session creation (`POST /v1/sessions` +
  `user.message`) rather than new platform code — no new harness needed,
  this is a config + prompt exercise, not a runtime change.
- System prompt should instruct: run `pnpm typecheck && pnpm test`, inspect
  `.github/workflows/*.yml` run history via `gh run list`, and for each new
  failure class not already tracked in `docs/agent-backlog.md`, append a
  backlog entry (or file a `gh issue create` once issues are live).

**Acceptance criteria**:
- [ ] Agent config committed (e.g. `docs/agents/self-improvement-agent.json` or similar) usable via CLI/API
- [ ] Documented cron/schedule trigger (GitHub Actions workflow or `/loop`) that creates a session periodically
- [ ] Agent successfully appends a backlog/issue entry in a dry-run
- [ ] Guardrail: agent never force-pushes/merges — read-only + issue/backlog-file writes only

---

## 7. Example agents + ready-to-use Docker images built in parallel in CI

**Motivation**: New users need copy-pasteable example agent configs and
pre-built sandbox images so they can try the platform without building
images themselves. CI already builds sandbox/node images sequentially in
places; building example images in parallel keeps CI fast as examples grow.

**Proposed approach**:
- Add `examples/agents/*.json` (following the "Full Configuration" example
  in `AGENTS.md`) for a handful of common personas: coding assistant, data
  analyst (mirrors the `data-science` environment example in `AGENTS.md`),
  research agent with `web_search`/`web_fetch`.
- Add matching example Dockerfiles/environment configs under
  `examples/environments/` if they need non-default packages, following the
  pattern of `apps/agent/Dockerfile.sandbox`.
- Extend `.github/workflows/build-sandbox-image.yml` and
  `build-node-images.yml` (or add a new `build-example-images.yml`) with a
  `strategy.matrix` over the example set so each example image builds as an
  independent parallel job rather than a sequential loop.
- Publish built example images to GHCR (existing pattern per commit
  `cc4f308` "configure Flue runtime… GHCR" — check `.github/workflows/`
  for the current registry/push step to mirror).

**Acceptance criteria**:
- [ ] At least 3 example agent JSON configs added under `examples/agents/`
- [ ] Corresponding example images build successfully via a matrix job in CI
- [ ] Matrix jobs run in parallel (verified via workflow run graph, not sequential)
- [ ] README/docs pointer from `AGENTS.md` or `docs/` to the examples directory
- [ ] No changes required to existing non-example CI jobs' pass/fail status
