---
name: new-harness
description: Scaffold a new agent harness for open-managed-agents and register it. Use when adding a new way to drive the model loop, like the default / acp-proxy / flue harnesses.
disable-model-invocation: true
---

Scaffold a new harness named `$ARGUMENTS` (the string an agent selects via `harness: "<name>"`).

1. **Read the current contract first** — open `apps/agent/src/harness/interface.ts` and use the live `HarnessInterface`, `HarnessContext`, and `HarnessRuntime` shapes. Do NOT assume a signature from memory; the interface evolves.

2. **Study a real implementation** for the pattern:
   - `apps/agent/src/harness/default-loop.ts` (`DefaultHarness`) — drives its own `streamText`/`generateText` loop.
   - `apps/agent/src/harness/acp-proxy-loop.ts` / `flue-loop.ts` — *meta*-harnesses that hand the turn to an external runtime and make `shouldCompact` / `compact` / `deriveModelContext` deliberate no-ops.

3. **Create** `apps/agent/src/harness/<name>-loop.ts` exporting a class that implements `HarnessInterface`. `run(ctx)` is required; only override the optional hooks (`onSessionInit`, `shouldCompact`, `compact`, `deriveModelContext`) where this harness must diverge from platform defaults. If you override `deriveModelContext`, keep its output **byte-deterministic** — the prompt cache invalidates on any prefix drift (see the interface comments).

4. **Register it** in `apps/agent/src/index.ts`, next to the existing `registerHarness(...)` calls:
   ```ts
   import { <Name>Harness } from "./harness/<name>-loop";
   registerHarness("<name>", () => new <Name>Harness());
   ```

5. **Add a unit test** alongside the existing harness tests, then run `/preflight`.
