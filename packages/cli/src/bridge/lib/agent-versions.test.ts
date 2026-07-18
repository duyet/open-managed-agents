import { describe, it, expect } from "vitest";
import {
  parseVersion,
  probeAgentVersion,
  attachAgentVersions,
  type VersionExec,
} from "./agent-versions.js";

/** Build an injectable exec that returns canned output per command, and
 *  records which commands were probed. */
function fakeExec(
  table: Record<string, { code?: number | null; out: string } | Error>,
): { exec: VersionExec; calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const exec: VersionExec = async (cmd, args) => {
    calls.push({ cmd, args });
    const entry = table[cmd];
    if (entry instanceof Error) throw entry;
    if (!entry) return { code: 127, out: "" };
    return { code: entry.code ?? 0, out: entry.out };
  };
  return { exec, calls };
}

describe("parseVersion", () => {
  it("extracts semver from typical --version output", () => {
    expect(parseVersion("claude 1.2.3 (build abc)")).toBe("1.2.3");
    expect(parseVersion("v0.7")).toBe("0.7");
    expect(parseVersion("codex-acp 2024.1.0-beta.1")).toBe("2024.1.0-beta.1");
  });

  it("returns undefined when nothing version-shaped is present", () => {
    expect(parseVersion("unknown")).toBeUndefined();
    expect(parseVersion("")).toBeUndefined();
    expect(parseVersion("released 2024")).toBeUndefined(); // single int, no dots
  });
});

describe("probeAgentVersion", () => {
  it("probes the wrapped upstream binary, not the thin wrapper", async () => {
    const { exec, calls } = fakeExec({ claude: { out: "1.9.0" } });
    const v = await probeAgentVersion(
      { id: "claude-acp", binary: "claude-agent-acp", wraps: "claude" },
      exec,
    );
    expect(v).toBe("1.9.0");
    expect(calls).toEqual([{ cmd: "claude", args: ["--version"] }]);
  });

  it("falls back to the reported binary when there is no wrapper", async () => {
    const { exec, calls } = fakeExec({ gemini: { out: "gemini 0.4.2" } });
    const v = await probeAgentVersion({ id: "gemini", binary: "gemini" }, exec);
    expect(v).toBe("0.4.2");
    expect(calls[0].cmd).toBe("gemini");
  });

  it("skips opaque package-manager launchers (npx/uvx)", async () => {
    const { exec, calls } = fakeExec({ npx: { out: "10.2.0" } });
    const v = await probeAgentVersion({ id: "some-agent", binary: "npx" }, exec);
    expect(v).toBeUndefined();
    expect(calls).toHaveLength(0); // never even spawned
  });

  it("is fail-soft when the probe throws", async () => {
    const { exec } = fakeExec({ codex: new Error("ENOENT") });
    const v = await probeAgentVersion({ id: "codex-acp", binary: "codex-acp", wraps: "codex" }, exec);
    expect(v).toBeUndefined();
  });

  it("is fail-soft when output has no version token", async () => {
    const { exec } = fakeExec({ hermes: { out: "hermes agent (dev)" } });
    const v = await probeAgentVersion({ id: "hermes", binary: "hermes" }, exec);
    expect(v).toBeUndefined();
  });
});

describe("attachAgentVersions", () => {
  it("attaches versions in parallel and omits unknowns", async () => {
    const { exec } = fakeExec({
      claude: { out: "1.9.0" },
      codex: new Error("boom"),
      gemini: { out: "0.4.2" },
    });
    const out = await attachAgentVersions(
      [
        { id: "claude-acp", binary: "claude-agent-acp", wraps: "claude" },
        { id: "codex-acp", binary: "codex-acp", wraps: "codex" },
        { id: "gemini", binary: "gemini" },
      ],
      exec,
    );
    expect(out).toEqual([
      { id: "claude-acp", binary: "claude-agent-acp", wraps: "claude", version: "1.9.0" },
      { id: "codex-acp", binary: "codex-acp", wraps: "codex" },
      { id: "gemini", binary: "gemini", version: "0.4.2" },
    ]);
  });

  it("preserves extra fields on the target", async () => {
    const { exec } = fakeExec({ claude: { out: "1.0.0" } });
    const out = await attachAgentVersions(
      [{ id: "claude-acp", binary: "claude", featured: true } as { id: string; binary: string; featured: boolean }],
      exec,
    );
    expect(out[0]).toMatchObject({ featured: true, version: "1.0.0" });
  });
});
