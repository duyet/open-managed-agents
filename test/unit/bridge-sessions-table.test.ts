// @ts-nocheck
/**
 * Pure renderer for the running-sessions block in `oma bridge status`.
 * Color is auto-disabled in the vitest pool (stderr isn't a TTY), so the
 * asserted strings are plain text.
 */

import { describe, it, expect } from "vitest";
import {
  renderSessionsTable,
  type SessionRow,
} from "../../packages/cli/src/bridge/lib/sessions-probe";

const NOW = 1_700_000_000_000;

const rows: SessionRow[] = [
  {
    id: "sess-abc123",
    agentName: "Support bot",
    status: "running",
    startedAt: NOW - 5 * 60_000,
    lastActivityAt: NOW - 12_000,
  },
];

describe("renderSessionsTable", () => {
  it("prints a single dim line (not an empty table) when there are no rows", () => {
    const lines = renderSessionsTable([], { baseUrl: "https://app.oma.duyet.net" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("no running sessions");
  });

  it("renders id, agent, status, and both ages", () => {
    const lines = renderSessionsTable(rows, { baseUrl: "https://app.oma.duyet.net", now: NOW });
    const joined = lines.join("\n");
    expect(joined).toContain("sess-abc123");
    expect(joined).toContain("Support bot");
    expect(joined).toContain("running");
    expect(joined).toContain("started 5m ago");
    expect(joined).toContain("active 12s ago");
  });

  it("emits an actionable dashboard deep-link and a tail hint per row", () => {
    const lines = renderSessionsTable(rows, { baseUrl: "https://app.oma.duyet.net", now: NOW });
    const joined = lines.join("\n");
    expect(joined).toContain("https://app.oma.duyet.net/sessions/sess-abc123");
    expect(joined).toContain("oma sessions tail sess-abc123");
  });

  it("strips a trailing slash from the base URL when building links", () => {
    const lines = renderSessionsTable(rows, { baseUrl: "https://app.oma.duyet.net/", now: NOW });
    expect(lines.join("\n")).toContain("https://app.oma.duyet.net/sessions/sess-abc123");
    expect(lines.join("\n")).not.toContain(".net//sessions");
  });

  it("renders a dash for a missing activity timestamp", () => {
    const lines = renderSessionsTable(
      [{ ...rows[0], lastActivityAt: null }],
      { baseUrl: "https://x.test", now: NOW },
    );
    expect(lines.join("\n")).toContain("active —");
  });

  it("produces three lines per session (row + 2 deep-links)", () => {
    const two = [rows[0], { ...rows[0], id: "sess-def456" }];
    const lines = renderSessionsTable(two, { baseUrl: "https://x.test", now: NOW });
    expect(lines).toHaveLength(6);
  });
});
