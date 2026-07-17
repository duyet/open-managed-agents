import { useCallback, useState } from "react";

/**
 * Persisted configuration for the Kanban page's "GitHub Issues" board.
 *
 * The Console has no per-user/tenant settings store today (theme + tenant
 * pin both live in `localStorage` — see `lib/theme.ts`,
 * `components/TenantSwitcher.tsx`), so the board config follows the same
 * convention: a single namespaced `localStorage` key. It's UI preference,
 * not security-sensitive — no tokens or credentials live here (those stay
 * server-side in the vault), only which installation/repo/filters to show.
 */
export interface GitHubBoardConfig {
  /** Selected GitHub installation id (`inst_*` / integration row id). */
  installationId: string;
  /** `owner/repo` slug of the board's repo. */
  repo: string;
  state: "open" | "closed";
  /** Comma-separated label names. */
  labels: string;
  /** GitHub login to filter by, or `none` for unassigned. */
  assignee: string;
  /** Free-text keyword search (title + body). */
  q: string;
  /** Display name for the board. */
  boardName: string;
}

export const EMPTY_GITHUB_BOARD_CONFIG: GitHubBoardConfig = {
  installationId: "",
  repo: "",
  state: "open",
  labels: "",
  assignee: "",
  q: "",
  boardName: "",
};

const STORAGE_KEY = "oma.kanban.github-board.v1";

function read(): GitHubBoardConfig {
  if (typeof localStorage === "undefined") return EMPTY_GITHUB_BOARD_CONFIG;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_GITHUB_BOARD_CONFIG;
    const parsed = JSON.parse(raw) as Partial<GitHubBoardConfig>;
    // Merge over defaults so a config written by an older shape stays valid.
    return { ...EMPTY_GITHUB_BOARD_CONFIG, ...parsed };
  } catch {
    return EMPTY_GITHUB_BOARD_CONFIG;
  }
}

/**
 * `localStorage`-backed config with the usual `[value, setValue]` shape.
 * Writes are best-effort (private-mode / quota failures are swallowed) —
 * the board still works in-memory for the session if persistence fails.
 */
export function useGitHubBoardConfig(): [
  GitHubBoardConfig,
  (next: GitHubBoardConfig) => void,
] {
  const [config, setConfig] = useState<GitHubBoardConfig>(read);

  const update = useCallback((next: GitHubBoardConfig) => {
    setConfig(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // ignore — persistence is a nicety, not a requirement
    }
  }, []);

  return [config, update];
}
