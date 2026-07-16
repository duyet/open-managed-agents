/**
 * Raw agent runtime detection — scans PATH for known AI coding agent binaries.
 *
 * This is the "Raft-style" detection: it looks for the actual agent binaries
 * (claude, codex, cursor, ...) that users install, NOT the ACP-wrapper binaries
 * (claude-agent-acp, codex-acp, ...) that OMA's bridge layer uses.
 *
 * Independent from the ACP registry in @duyet/oma-acp-runtime. Used by:
 *   - `oma runtimes detect` standalone command (mirrors Raft's "Runtimes detected: ...")
 *   - `oma bridge setup` initial machine scan (alongside ACP detection)
 */

import { spawn } from "node:child_process";

export interface KnownRuntime {
  /** Binary name as it appears on PATH (e.g. "claude", "codex") */
  binary: string;
  /** User-facing display label (e.g. "Claude Code", "Codex CLI") */
  label: string;
  /** Optional homepage for more info / install instructions */
  homepage?: string;
}

export interface DetectedRuntime extends KnownRuntime {
  /** Always true — this interface only exists when the binary was found */
  detected: true;
}

/**
 * Known AI coding agent binaries, matching Raft's detected-agent roster.
 *
 * Order: popular / well-known first, then long-tail. Each entry is a raw
 * binary `which` looks up on PATH — no npm/uvx wrappers, no ACP proxies.
 * If you install `npm i -g @anthropic-ai/claude-code` and the binary lands
 * on PATH as `claude`, we detect it here.
 */
export const KNOWN_RUNTIMES: KnownRuntime[] = [
  { binary: "claude",      label: "Claude Code",       homepage: "https://docs.anthropic.com/en/docs/claude-code/overview" },
  { binary: "codex",       label: "Codex CLI",          homepage: "https://codex.cli/" },
  { binary: "cursor",      label: "Cursor CLI",         homepage: "https://cursor.sh" },
  { binary: "gemini",      label: "Gemini CLI",         homepage: "https://cloud.google.com/gemini-cli" },
  { binary: "antigravity", label: "Antigravity CLI",    homepage: "https://github.com/antigravity-ai/antigravity" },
  { binary: "kimi",        label: "Kimi CLI",           homepage: "https://kimi.moonshot.cn/" },
  { binary: "copilot",     label: "Copilot CLI",        homepage: "https://github.com/github-copilot/cli" },
  { binary: "opencode",    label: "OpenCode",           homepage: "https://opencode.ai/" },
  { binary: "pi",          label: "Pi",                 homepage: "https://pi.ai" },
];

/**
 * Check whether a binary is on PATH using `which` (or `where` on Windows).
 * Mirrors the same pattern used in @duyet/oma-acp-runtime/registry.ts.
 */
function isOnPath(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = process.platform === "win32" ? "where" : "which";
    const p = spawn(probe, [cmd], { stdio: "ignore" });
    p.once("error", () => resolve(false));
    p.once("exit", (code) => resolve(code === 0));
  });
}

/**
 * Detect every known runtime binary on PATH. Returns only the ones found.
 *
 * Pure async, no side effects, independent of any ACP registry or cache.
 * All checks run in parallel — typically completes in <100ms.
 */
export async function detectRuntimes(): Promise<DetectedRuntime[]> {
  const results = await Promise.all(
    KNOWN_RUNTIMES.map(async (r) => {
      const found = await isOnPath(r.binary);
      return found ? { ...r, detected: true as const } : null;
    }),
  );
  return results.filter((r): r is DetectedRuntime => r !== null);
}
