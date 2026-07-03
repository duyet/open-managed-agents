// Unit test for the Flue runtime bridge (`runFlueAgentTurn`,
// src/harness/flue/runtime-bridge.ts). Exercises the real @flue/runtime
// module graph (registerProvider, defineAgent, observe, and — through the
// bridge — configureFlueRuntime) against a fake OMA sandbox: no container,
// no real network call. The model call itself is served by pi-ai's built-in
// "faux" provider (`@earendil-works/pi-ai/compat`, a dependency of
// `@flue/runtime` already in the lockfile) instead of a hand-rolled fetch
// mock, since Flue always speaks SSE to its providers — a mocked non-SSE
// response wouldn't parse, and a mocked error response would enter Flue's
// retry/backoff loop rather than settling quickly.
//
// Before this bridge existed, driving ANY Flue agent turn failed
// synchronously and immediately with "[flue] dispatch() called before
// runtime was configured. This usually means it was used outside a
// Flue-built server entry." — regardless of agent/model/sandbox
// correctness, because nothing had ever called `configureFlueRuntime(...)`.
// This test proves that's fixed by running a turn all the way to a real
// assistant reply.

import { describe, it, expect } from "vitest";
import { defineAgent, registerProvider, observe, createSandboxSessionEnv } from "@flue/runtime";
import type { FlueEvent, SandboxApi, SandboxFactory } from "@flue/runtime";
import { registerFauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { runFlueAgentTurn } from "../src/harness/flue/runtime-bridge";

/** Inert fake — a Flue turn with no tool calls never touches the sandbox
 *  beyond constructing its `SessionEnv`. */
function fakeSandboxFactory(): SandboxFactory {
  const api: SandboxApi = {
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    readFile: async () => "",
    readFileBuffer: async () => new Uint8Array(),
    writeFile: async () => {},
    stat: async () => {
      throw new Error("stat: no such file");
    },
    readdir: async () => [],
    exists: async () => false,
    mkdir: async () => {},
    rm: async () => {},
  };
  return { createSessionEnv: async () => createSandboxSessionEnv(api, "/workspace") };
}

describe("runFlueAgentTurn", () => {
  it("drives a real Flue turn to completion instead of throwing 'runtime was configured'", async () => {
    const faux = registerFauxProvider();
    faux.setResponses([fauxAssistantMessage("Hello from the faux model.")]);
    registerProvider("rb-test", { api: faux.api, baseUrl: "http://faux.invalid" });

    const agent = defineAgent(() => ({
      model: `rb-test/${faux.getModel().id}`,
      sandbox: fakeSandboxFactory(),
      instructions: "You are a test agent.",
    }));

    const instanceId = `rb-test-${crypto.randomUUID()}`;
    const events: FlueEvent[] = [];
    const unobserve = observe((event) => {
      if (event.instanceId === instanceId) events.push(event);
    });

    let result: unknown;
    try {
      result = await runFlueAgentTurn({ agent, instanceId, message: "hello" });
    } finally {
      unobserve();
    }

    // The historical bug fired here, synchronously, before any of this ---
    // a resolved turn (any outcome) proves `configureFlueRuntime` ran and
    // Flue's coordinator/harness machinery actually drove the turn.
    expect(result).toBeDefined();
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
    expect(events.map((e) => e.type)).toContain("message_end");
  }, 60000);
});
