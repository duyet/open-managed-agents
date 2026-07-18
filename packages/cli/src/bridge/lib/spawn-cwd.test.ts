// Unit tests for resolveSpawnCwd — the local-agent-binding cwd resolution
// used by SessionManager.start(). git side effects are injected via a fake
// `runGit` so these run without a real git binary or network.

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { resolveSpawnCwd, type RunGit } from "./spawn-cwd.js";
import { paths } from "./platform.js";

let workingDir: string | undefined;

afterEach(() => {
  if (workingDir) {
    try { rmSync(workingDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    workingDir = undefined;
  }
  // Clean up any worktree parent dir this test run may have created under
  // the real ~/.oma/bridge/sessions/worktrees/ (resolveSpawnCwd computes
  // worktree paths off the real `paths().sessionsDir` — not injectable).
  try {
    rmSync(join(paths().sessionsDir, "worktrees"), { recursive: true, force: true });
  } catch { /* best-effort */ }
  // Same for the synthetic session cwd the "unset working_dir" test creates
  // via the real ensureSessionCwd fallback (also not injectable).
  const defaultDirName = createHash("sha256").update("sess_default_1").digest("hex").slice(0, 12);
  try {
    rmSync(join(paths().sessionsDir, defaultDirName), { recursive: true, force: true });
  } catch { /* best-effort */ }
});

function recordingRunGit(behavior?: (args: string[], cwd: string) => void | never): { runGit: RunGit; calls: Array<{ args: string[]; cwd: string }> } {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const runGit: RunGit = async (args, cwd) => {
    calls.push({ args, cwd });
    behavior?.(args, cwd);
  };
  return { runGit, calls };
}

describe("resolveSpawnCwd", () => {
  it("delegates to ensureSessionCwd (unchanged default) when working_dir is unset", async () => {
    const { runGit, calls } = recordingRunGit();
    const cwd = await resolveSpawnCwd({ sessionId: "sess_default_1", runGit });
    expect(cwd).toContain(join(".oma", "bridge", "sessions"));
    expect(calls).toHaveLength(0);
  });

  it("uses working_dir directly when no branch/worktree given", async () => {
    workingDir = mkdtempSync(join(tmpdir(), "oma-spawn-cwd-"));
    const { runGit, calls } = recordingRunGit();
    const cwd = await resolveSpawnCwd({ sessionId: "sess_1", workingDir, runGit });
    expect(cwd).toBe(workingDir);
    expect(calls).toHaveLength(0);
  });

  it("throws when working_dir does not exist", async () => {
    const { runGit } = recordingRunGit();
    await expect(
      resolveSpawnCwd({ sessionId: "sess_1", workingDir: join(tmpdir(), "oma-does-not-exist-xyz"), runGit }),
    ).rejects.toThrow(/does not exist/);
  });

  it("throws when working_dir is a file, not a directory", async () => {
    workingDir = mkdtempSync(join(tmpdir(), "oma-spawn-cwd-"));
    const filePath = join(workingDir, "a-file.txt");
    writeFileSync(filePath, "not a dir");
    const { runGit } = recordingRunGit();
    await expect(
      resolveSpawnCwd({ sessionId: "sess_1", workingDir: filePath, runGit }),
    ).rejects.toThrow(/not a directory/);
  });

  it("checks out an existing branch in working_dir and returns working_dir as cwd", async () => {
    workingDir = mkdtempSync(join(tmpdir(), "oma-spawn-cwd-"));
    const { runGit, calls } = recordingRunGit();
    const cwd = await resolveSpawnCwd({ sessionId: "sess_1", workingDir, branch: "main", runGit });
    expect(cwd).toBe(workingDir);
    expect(calls).toEqual([{ args: ["checkout", "main"], cwd: workingDir }]);
  });

  it("falls back to creating the branch when checkout fails", async () => {
    workingDir = mkdtempSync(join(tmpdir(), "oma-spawn-cwd-"));
    let attempt = 0;
    const { runGit, calls } = recordingRunGit(() => {
      attempt += 1;
      if (attempt === 1) throw new Error("pathspec did not match any file(s)");
    });
    const cwd = await resolveSpawnCwd({ sessionId: "sess_1", workingDir, branch: "feature/new", runGit });
    expect(cwd).toBe(workingDir);
    expect(calls).toEqual([
      { args: ["checkout", "feature/new"], cwd: workingDir },
      { args: ["checkout", "-b", "feature/new"], cwd: workingDir },
    ]);
  });

  it("rejects a branch name with shell-meta characters before touching git", async () => {
    workingDir = mkdtempSync(join(tmpdir(), "oma-spawn-cwd-"));
    const { runGit, calls } = recordingRunGit();
    await expect(
      resolveSpawnCwd({ sessionId: "sess_1", workingDir, branch: "main; rm -rf /", runGit }),
    ).rejects.toThrow(/invalid branch name/);
    expect(calls).toHaveLength(0);
  });

  it("rejects a branch name starting with a dash before touching git", async () => {
    workingDir = mkdtempSync(join(tmpdir(), "oma-spawn-cwd-"));
    const { runGit, calls } = recordingRunGit();
    await expect(
      resolveSpawnCwd({ sessionId: "sess_1", workingDir, branch: "--upload-pack=evil", runGit }),
    ).rejects.toThrow(/invalid branch name/);
    expect(calls).toHaveLength(0);
  });

  it("creates a worktree from the given branch and returns the worktree path as cwd", async () => {
    workingDir = mkdtempSync(join(tmpdir(), "oma-spawn-cwd-"));
    const { runGit, calls } = recordingRunGit();
    const cwd = await resolveSpawnCwd({
      sessionId: "sess_worktree_1",
      workingDir,
      worktree: { branch: "main" },
      runGit,
    });
    expect(cwd).not.toBe(workingDir);
    expect(cwd).toContain(join("sessions", "worktrees"));
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0]).toBe("worktree");
    expect(calls[0].args[1]).toBe("add");
    expect(calls[0].args[2]).toBe(cwd);
    expect(calls[0].args[3]).toBe("main");
    expect(calls[0].cwd).toBe(workingDir);
  });

  it("falls back to `git worktree add -b` when the branch doesn't exist yet", async () => {
    workingDir = mkdtempSync(join(tmpdir(), "oma-spawn-cwd-"));
    let attempt = 0;
    const { runGit, calls } = recordingRunGit(() => {
      attempt += 1;
      if (attempt === 1) throw new Error("invalid reference: feature/brand-new");
    });
    const cwd = await resolveSpawnCwd({
      sessionId: "sess_worktree_2",
      workingDir,
      worktree: { branch: "feature/brand-new" },
      runGit,
    });
    expect(calls).toHaveLength(2);
    expect(calls[1].args).toEqual(["worktree", "add", "-b", "feature/brand-new", cwd]);
  });

  it("worktree takes precedence over branch when both are set", async () => {
    workingDir = mkdtempSync(join(tmpdir(), "oma-spawn-cwd-"));
    const { runGit, calls } = recordingRunGit();
    const cwd = await resolveSpawnCwd({
      sessionId: "sess_worktree_3",
      workingDir,
      branch: "ignored-branch",
      worktree: { branch: "wins" },
      runGit,
    });
    expect(cwd).not.toBe(workingDir);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(["worktree", "add", cwd, "wins"]);
  });
});
