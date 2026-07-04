import { describe, expect, it } from "vitest";
import { deriveKanbanColumn } from "./kanban";

describe("deriveKanbanColumn", () => {
  it("places running sessions in the running column regardless of events", () => {
    expect(deriveKanbanColumn("running", null)).toBe("running");
    expect(deriveKanbanColumn("running", { type: "agent.tool_use" })).toBe("running");
  });

  it("places terminated sessions in done regardless of events", () => {
    expect(deriveKanbanColumn("terminated", null)).toBe("done");
    expect(
      deriveKanbanColumn("terminated", {
        type: "session.status_idle",
        stop_reason: { type: "requires_action" },
      }),
    ).toBe("done");
  });

  it("places rescheduling sessions in queued — container hasn't run yet", () => {
    expect(deriveKanbanColumn("rescheduling", null)).toBe("queued");
  });

  it("places a never-started idle session (no events) in queued", () => {
    expect(deriveKanbanColumn("idle", null)).toBe("queued");
    expect(deriveKanbanColumn(undefined, null)).toBe("queued");
  });

  it("treats an in-flight last-event fetch (undefined) the same as no events", () => {
    expect(deriveKanbanColumn("idle", undefined)).toBe("queued");
  });

  it("places an idle session whose last event requires action in blocked", () => {
    expect(
      deriveKanbanColumn("idle", {
        type: "session.status_idle",
        stop_reason: { type: "requires_action" },
      }),
    ).toBe("blocked");
  });

  it("places an idle session that finished a turn cleanly in done", () => {
    expect(
      deriveKanbanColumn("idle", {
        type: "session.status_idle",
        stop_reason: { type: "end_turn" },
      }),
    ).toBe("done");
  });

  it("places an idle session with a status_idle event and no stop_reason in done", () => {
    expect(deriveKanbanColumn("idle", { type: "session.status_idle" })).toBe("done");
  });

  it("places an idle session whose last event is something else (e.g. post-error recovery) in done", () => {
    expect(deriveKanbanColumn("idle", { type: "session.error" })).toBe("done");
  });
});
