// NodeSessionRouter.appendEvent — surfaces session.error on a failed
// harness turn (issue #135).
//
// Before this change, a harness-turn failure (including the new turn
// watchdog's TurnWatchdogTimeoutError) was only logged server-side
// (`moduleLog.error`) — the event log never got a `session.error` event,
// so an SSE/poll consumer saw the session quietly return to idle with no
// signal that anything went wrong. This proves the fire-and-forget
// `.catch()` in appendEvent now appends + publishes session.error too.

import { describe, it, expect } from "vitest";
import { bootstrapTestDb } from "./_helpers/bootstrap-test-db";
import { SqlEventLog, ensureSchema as ensureEventLogSchema } from "@duyet/oma-event-log/sql";
import { InProcessEventStreamHub } from "../src/lib/event-stream-hub.js";
import { NodeSessionRouter } from "../src/lib/node-session-router.js";
import type { SessionRegistry } from "../src/registry.js";
import type { UserMessageEvent } from "@duyet/oma-shared";

const TENANT = "tn_watchdog";
const SESSION = "sess_watchdog";
const AGENT = "agent_watchdog";

async function bootstrap(harnessError: unknown) {
  const { sql, db, cleanup } = await bootstrapTestDb();
  await ensureEventLogSchema(sql);
  const now = Date.now();
  await sql
    .prepare(`INSERT INTO "tenant" (id, name, "createdAt", "updatedAt") VALUES (?, ?, ?, ?)`)
    .bind(TENANT, "Watchdog Test", now, now)
    .run();
  await sql
    .prepare(
      `INSERT INTO sessions (id, tenant_id, agent_id, status, created_at, updated_at)
       VALUES (?, ?, ?, 'idle', ?, ?)`,
    )
    .bind(SESSION, TENANT, AGENT, now, now)
    .run();

  const hub = new InProcessEventStreamHub();
  const newEventLog = (sid: string) => new SqlEventLog(sql, sid, () => {});

  // Minimal fake registry: the router only calls getOrCreate(sid, tid) and
  // reads `.machine.runHarnessTurn(...)` off the result — everything else
  // (sandbox/eventLog fields) is unused by appendEvent.
  const fakeMachine = {
    runHarnessTurn: async (_agentId: string, _msg: UserMessageEvent) => {
      throw harnessError;
    },
  };
  const registry = {
    getOrCreate: async () => ({ machine: fakeMachine, sandbox: {}, eventLog: newEventLog(SESSION) }),
  } as unknown as SessionRegistry;

  const router = new NodeSessionRouter({ sql, hub, registry, newEventLog });
  return { sql, hub, router, newEventLog, cleanup, db };
}

/** Poll until the event log carries a session.error, or fail after a
 *  generous ceiling — appendEvent's harness call is fire-and-forget so
 *  the catch's async work lands a tick or two after appendEvent returns. */
async function waitForSessionError(newEventLog: (sid: string) => SqlEventLog, sid: string) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const events = await newEventLog(sid).getEventsAsync();
    const found = events.find((e) => (e as { type?: string }).type === "session.error");
    if (found) return found as { type: string; error?: string };
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out waiting for session.error to be appended");
}

/** Generic poll — the hub-publish assertion races the same fire-and-forget
 *  catch handler as waitForSessionError above (publish fires after an
 *  extra `await errLog.getEventsAsync()` past the DB write a direct poll
 *  can observe), so it needs the same wait-not-check-once treatment. */
async function waitFor(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

describe("NodeSessionRouter.appendEvent — session.error surfacing (issue #135)", () => {
  it("appends + publishes session.error when the harness turn rejects", async () => {
    const { hub, router, newEventLog, cleanup } = await bootstrap(new Error("harness blew up"));
    try {
      const published: unknown[] = [];
      hub.attach(SESSION, {
        closed: false,
        write: (ev) => published.push(ev),
        close: () => {},
      });

      const userMessage: UserMessageEvent = { type: "user.message", content: [{ type: "text", text: "hi" }] };
      const result = await router.appendEvent(SESSION, userMessage);
      expect(result.status).toBe(202);

      const errorEvent = await waitForSessionError(newEventLog, SESSION);
      expect(errorEvent.error).toBe("harness blew up");
      await waitFor(
        () => published.some((ev) => (ev as { type?: string }).type === "session.error"),
        "session.error to be published to the hub",
      );
    } finally {
      cleanup();
    }
  });

  it("surfaces a TurnWatchdogTimeoutError's message the same way as any other harness failure", async () => {
    // Import lazily to avoid a hard dep on the exact error class if this
    // test runs before the package builds; the router only cares that
    // it's an Error with a message, same as any other harness failure.
    const { TurnWatchdogTimeoutError } = await import("@duyet/oma-session-runtime");
    const { newEventLog, router, cleanup } = await bootstrap(new TurnWatchdogTimeoutError(5000));
    try {
      const userMessage: UserMessageEvent = { type: "user.message", content: [{ type: "text", text: "hi" }] };
      await router.appendEvent(SESSION, userMessage);

      const errorEvent = await waitForSessionError(newEventLog, SESSION);
      expect(errorEvent.error).toMatch(/turn watchdog/i);
      expect(errorEvent.error).toMatch(/issue #135/);
    } finally {
      cleanup();
    }
  });
});
