/**
 * Spawn-cwd resolution for `session.start` — decides which directory the
 * ACP child spawns into.
 *
 * Default (all of `workingDir` / `branch` / `worktree` unset): unchanged
 * behavior — the daemon's synthetic per-session directory from
 * `ensureSessionCwd` (`~/.oma/bridge/sessions/<session-id>/`).
 *
 * Local-agent-binding (advanced): when `workingDir` is set, the ACP child
 * instead spawns into a real project directory on the paired machine:
 *
 *   - `workingDir` alone → use it directly as cwd.
 *   - `workingDir` + `branch` → `git checkout <branch>` in `workingDir`
 *     first (falls back to `git checkout -b <branch>` if the branch
 *     doesn't exist yet), then use `workingDir` as cwd.
 *   - `workingDir` + `worktree.branch` → `git worktree add` a dedicated
 *     worktree off `workingDir` for that branch (falls back to
 *     `git worktree add -b` to create the branch if it doesn't exist),
 *     then use the worktree directory as cwd. Wins over `branch` if both
 *     are somehow set.
 *
 * `runGit` is injected so the git side effects are unit-testable without
 * shelling out for real — see spawn-cwd.test.ts.
 */

import { existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { ensureSessionCwd } from "./session-cwd.js";
import { paths } from "./platform.js";

/** Run a git command with the given args in `cwd`. Must reject (with the
 *  captured stderr, or an equivalent message) on a nonzero exit code. */
export type RunGit = (args: string[], cwd: string) => Promise<void>;

export interface ResolveSpawnCwdParams {
  sessionId: string;
  workingDir?: string;
  branch?: string;
  worktree?: { branch: string };
  runGit: RunGit;
}

const BRANCH_RE = /^[A-Za-z0-9._/-]+$/;

/**
 * Reject shell-meta characters and leading dashes (which `git` would
 * otherwise interpret as a flag) — mirrors the sanitize precedent in
 * `apps/agent/src/runtime/resource-mounter.ts` for branch checkout.
 */
function sanitizeBranch(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.startsWith("-") || !BRANCH_RE.test(trimmed)) {
    throw new Error(`invalid branch name: ${JSON.stringify(name)}`);
  }
  return trimmed;
}

/** Short, deterministic, filesystem-safe worktree dir name for a session id
 *  — same scheme as session-cwd.ts's dirNameFor so worktree paths look
 *  consistent with synthetic session dirs. */
function worktreeDirName(sessionId: string): string {
  if (/^[a-f0-9]{1,12}$/i.test(sessionId)) return sessionId.toLowerCase();
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 12);
}

export async function resolveSpawnCwd(params: ResolveSpawnCwdParams): Promise<string> {
  const { sessionId, workingDir, branch, worktree, runGit } = params;

  // Default path — unchanged behavior when nothing local-binding related is set.
  if (!workingDir) {
    return ensureSessionCwd(sessionId);
  }

  if (!existsSync(workingDir) || !statSync(workingDir).isDirectory()) {
    throw new Error(`runtime_binding.working_dir does not exist or is not a directory: ${workingDir}`);
  }

  if (worktree?.branch) {
    const branchName = sanitizeBranch(worktree.branch);
    const worktreePath = join(paths().sessionsDir, "worktrees", worktreeDirName(sessionId));
    await mkdir(dirname(worktreePath), { recursive: true });
    try {
      await runGit(["worktree", "add", worktreePath, branchName], workingDir);
    } catch {
      // Branch doesn't exist yet locally or on any remote — create it off
      // the repo's current HEAD instead of failing the whole spawn.
      await runGit(["worktree", "add", "-b", branchName, worktreePath], workingDir);
    }
    return worktreePath;
  }

  if (branch) {
    const branchName = sanitizeBranch(branch);
    try {
      await runGit(["checkout", branchName], workingDir);
    } catch {
      await runGit(["checkout", "-b", branchName], workingDir);
    }
    return workingDir;
  }

  return workingDir;
}
