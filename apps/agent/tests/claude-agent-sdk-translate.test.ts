// Unit tests for the Claude Agent SDK → OMA event translator. Pure logic
// only — a fake HarnessRuntime captures broadcast() calls, no CLI subprocess,
// no LLM. Mirrors flue-sandbox-bridge.test.ts / flue-provider-bridge.test.ts
// in style. Only type-only imports are pulled from
// @anthropic-ai/claude-agent-sdk here (erased at build time), so this test
// never loads the real SDK bundle — see the module-level note in
// ../src/harness/claude-agent-sdk/translate.ts about why sandbox-tools.ts
// (which DOES import the SDK at runtime) isn't exercised under this
// Cloudflare-Workers-pool test suite.

import { describe, it, expect } from "vitest";
import type { SessionEvent } from "@open-managed-agents/shared";
import type { HarnessRuntime } from "../src/harness/interface";
import { ClaudeAgentSdkEventTranslator } from "../src/harness/claude-agent-sdk/translate";
import type { SDKAssistantMessage, SDKUserMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

function fakeRuntime(): { runtime: HarnessRuntime; events: SessionEvent[] } {
  const events: SessionEvent[] = [];
  const runtime = {
    broadcast: (event: SessionEvent) => {
      events.push(event);
    },
  } as unknown as HarnessRuntime;
  return { runtime, events };
}

function assistantMessage(content: unknown[], error?: string): SDKAssistantMessage {
  return {
    type: "assistant",
    message: { content } as SDKAssistantMessage["message"],
    parent_tool_use_id: null,
    uuid: "11111111-1111-1111-1111-111111111111" as SDKAssistantMessage["uuid"],
    session_id: "sess-test",
    ...(error ? { error: error as SDKAssistantMessage["error"] } : {}),
  } as SDKAssistantMessage;
}

function userMessage(content: unknown[]): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content } as SDKUserMessage["message"],
    parent_tool_use_id: null,
  } as SDKUserMessage;
}

describe("ClaudeAgentSdkEventTranslator", () => {
  it("emits agent.message for a text block, trimming trailing whitespace", async () => {
    const { runtime, events } = fakeRuntime();
    const t = new ClaudeAgentSdkEventTranslator(runtime);
    await t.consume(assistantMessage([{ type: "text", text: "hello there  \n" }]));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "agent.message",
      content: [{ type: "text", text: "hello there" }],
    });
    expect(t.sawAssistantOutput).toBe(true);
  });

  it("drops empty text blocks without emitting an event", async () => {
    const { runtime, events } = fakeRuntime();
    const t = new ClaudeAgentSdkEventTranslator(runtime);
    await t.consume(assistantMessage([{ type: "text", text: "   " }]));
    expect(events).toHaveLength(0);
    expect(t.sawAssistantOutput).toBe(false);
  });

  it("emits agent.thinking for a thinking block", async () => {
    const { runtime, events } = fakeRuntime();
    const t = new ClaudeAgentSdkEventTranslator(runtime);
    await t.consume(assistantMessage([{ type: "thinking", thinking: "reasoning..." }]));
    expect(events).toEqual([{ type: "agent.thinking", text: "reasoning..." }]);
  });

  it("emits agent.tool_use for a tool_use block", async () => {
    const { runtime, events } = fakeRuntime();
    const t = new ClaudeAgentSdkEventTranslator(runtime);
    await t.consume(
      assistantMessage([{ type: "tool_use", id: "toolu_1", name: "bash", input: { command: "ls" } }]),
    );
    expect(events).toEqual([
      { type: "agent.tool_use", id: "toolu_1", name: "bash", input: { command: "ls" } },
    ]);
    expect(t.sawAssistantOutput).toBe(true);
  });

  it("preserves content-block order across a mixed assistant message", async () => {
    const { runtime, events } = fakeRuntime();
    const t = new ClaudeAgentSdkEventTranslator(runtime);
    await t.consume(
      assistantMessage([
        { type: "thinking", thinking: "let me check" },
        { type: "tool_use", id: "toolu_2", name: "read", input: { file_path: "/workspace/a.txt" } },
      ]),
    );
    expect(events.map((e) => e.type)).toEqual(["agent.thinking", "agent.tool_use"]);
  });

  it("surfaces an assistant message error as session.error and emits nothing else", async () => {
    const { runtime, events } = fakeRuntime();
    const t = new ClaudeAgentSdkEventTranslator(runtime);
    await t.consume(assistantMessage([{ type: "text", text: "should not appear" }], "rate_limit"));
    expect(events).toEqual([
      { type: "session.error", error: "Claude Agent SDK: rate_limit" },
    ]);
  });

  it("maps a tool_result content block to agent.tool_result with parent_event_id", async () => {
    const { runtime, events } = fakeRuntime();
    const t = new ClaudeAgentSdkEventTranslator(runtime);
    await t.consume(
      userMessage([
        { type: "tool_result", tool_use_id: "toolu_1", content: "exit=0\nfile listed" },
      ]),
    );
    expect(events).toEqual([
      {
        type: "agent.tool_result",
        tool_use_id: "toolu_1",
        content: "exit=0\nfile listed",
        parent_event_id: "toolu_1",
      },
    ]);
  });

  it("normalizes structured (array) tool_result content into ContentBlock[]", async () => {
    const { runtime, events } = fakeRuntime();
    const t = new ClaudeAgentSdkEventTranslator(runtime);
    await t.consume(
      userMessage([
        {
          type: "tool_result",
          tool_use_id: "toolu_3",
          content: [{ type: "text", text: "result text" }],
        },
      ]),
    );
    expect(events).toEqual([
      {
        type: "agent.tool_result",
        tool_use_id: "toolu_3",
        content: [{ type: "text", text: "result text" }],
        parent_event_id: "toolu_3",
      },
    ]);
  });

  it("ignores non-tool_result blocks in a user message", async () => {
    const { runtime, events } = fakeRuntime();
    const t = new ClaudeAgentSdkEventTranslator(runtime);
    await t.consume(userMessage([{ type: "text", text: "irrelevant echo" }]));
    expect(events).toHaveLength(0);
  });

  it("records the terminal result message without broadcasting", async () => {
    const { runtime, events } = fakeRuntime();
    const t = new ClaudeAgentSdkEventTranslator(runtime);
    const result: SDKResultMessage = {
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 1,
      result: "done",
      stop_reason: "end_turn",
      total_cost_usd: 0.01,
      usage: { input_tokens: 10, output_tokens: 5 } as SDKResultMessage["usage"],
      modelUsage: {},
      permission_denials: [],
      uuid: "22222222-2222-2222-2222-222222222222" as SDKResultMessage["uuid"],
      session_id: "sess-test",
      duration_ms: 100,
      duration_api_ms: 90,
    } as SDKResultMessage;
    await t.consume(result);
    expect(events).toHaveLength(0);
    expect(t.result).toBe(result);
  });

  it("drops unrecognized message kinds silently", async () => {
    const { runtime, events } = fakeRuntime();
    const t = new ClaudeAgentSdkEventTranslator(runtime);
    await t.consume({ type: "system", subtype: "init" } as unknown as SDKAssistantMessage);
    expect(events).toHaveLength(0);
  });
});
