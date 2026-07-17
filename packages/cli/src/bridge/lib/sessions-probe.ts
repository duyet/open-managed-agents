/**
 * "What's running on this machine right now" for `oma bridge status`.
 *
 * There is no server-side "sessions on this runtime" filter — `/v1/sessions`
 * only filters by `agent_id` / `status` / date range (see
 * packages/http-routes/src/sessions/index.ts). So we reconstruct the view
 * client-side: list the tenant's agents, keep the ones whose
 * `_oma.runtime_binding.runtime_id` points at THIS runtime, then list the
 * tenant's running sessions and keep the ones bound to those agents. Done
 * per authorized workspace (the daemon may serve several) and merged.
 *
 * This is observability-only and best-effort: any unreachable / unauthorized
 * workspace is skipped, and the caller renders a dim note rather than failing
 * the whole `status` command.
 *
 * Split into a pure renderer (`renderSessionsTable`, unit-tested with
 * injectable rows) and an impure collector (`fetchRuntimeSessions`, exercised
 * against a live server by the e2e lifecycle test).
 */

import { c } from "./style.js";
import { formatAge } from "./daemon-state.js";

export interface SessionRow {
  /** Full session id (sess-…). */
  id: string;
  /** Display name of the bound agent. */
  agentName: string;
  /** Lifecycle status (running). */
  status: string;
  /** Session start (unix ms), or null if unparseable. */
  startedAt: number | null;
  /** Last activity / update (unix ms), or null. */
  lastActivityAt: number | null;
}

export interface RuntimeSessionsResult {
  /** True when at least one authorized workspace was reached. */
  ok: boolean;
  /** Dim note for the status command when something was skipped. */
  note?: string;
  rows: SessionRow[];
}

interface ProbeCreds {
  serverUrl: string;
  runtimeId: string;
  tenants: Array<{ id: string; name: string; agentApiKey: string }>;
}

const UNKNOWN_TENANT_ID = "__unknown__";

/**
 * Render the running-sessions block as an array of stderr lines. Pure:
 * no I/O, no clock reads except the injectable `now`. When there are no
 * rows, returns a single dim line (never an empty table).
 *
 * Each session prints a compact table row plus two actionable follow-up
 * lines: the dashboard deep-link and the `oma sessions tail` hint.
 */
export function renderSessionsTable(
  rows: SessionRow[],
  opts: { baseUrl: string; now?: number },
): string[] {
  if (rows.length === 0) {
    return [`  ${c.dim("no running sessions on this runtime")}`];
  }
  const now = opts.now ?? Date.now();
  const base = opts.baseUrl.replace(/\/$/, "");
  const age = (ms: number | null) => (ms === null ? "—" : formatAge(now - ms));

  // Left-align id + agent + status into columns so the timing reads as a
  // clean fourth column; the deep-links sit on their own indented lines.
  const idW = Math.max(...rows.map((r) => r.id.length), 10);
  const agentW = Math.max(...rows.map((r) => r.agentName.length), 5);
  const statusW = Math.max(...rows.map((r) => r.status.length), 7);

  const lines: string[] = [];
  for (const r of rows) {
    const timing = `${c.dim("started")} ${age(r.startedAt)} ${c.dim("· active")} ${age(r.lastActivityAt)}`;
    lines.push(
      `  ${r.id.padEnd(idW)}  ${r.agentName.padEnd(agentW)}  ${c.green(r.status.padEnd(statusW))}  ${timing}`,
    );
    lines.push(`    ${c.dim("↳")} ${c.cyan(`${base}/sessions/${r.id}`)}`);
    lines.push(`    ${c.dim("↳")} ${c.dim(`oma sessions tail ${r.id}  (stream live logs)`)}`);
  }
  return lines;
}

/** Minimal shapes of the API responses we consume. */
interface AgentListItem {
  id: string;
  name?: string;
  _oma?: { runtime_binding?: { runtime_id?: string } };
}
interface SessionListItem {
  id: string;
  agent_id: string;
  status: string;
  created_at?: string;
  updated_at?: string | null;
  agent?: { name?: string };
}

/**
 * Collect running sessions bound to this runtime across all authorized
 * workspaces. Never throws — unreachable/unauthorized workspaces are
 * skipped and surfaced via `note`.
 */
export async function fetchRuntimeSessions(
  creds: ProbeCreds,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<RuntimeSessionsResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const base = creds.serverUrl.replace(/\/$/, "");

  const realTenants = creds.tenants.filter(
    (t) => t.id !== UNKNOWN_TENANT_ID && t.agentApiKey,
  );
  if (realTenants.length === 0) {
    return {
      ok: false,
      note: "no authorized workspace credentials — run `oma bridge refresh`",
      rows: [],
    };
  }

  const get = async (apiKey: string, path: string): Promise<unknown> => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await doFetch(`${base}${path}`, {
        headers: {
          "x-api-key": apiKey,
          "content-type": "application/json",
          "user-agent": "Mozilla/5.0 (compatible; OMA-CLI/0.1; +https://oma.duyet.net)",
        },
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  };

  const rows: SessionRow[] = [];
  let reachedAny = false;
  let skipped = 0;

  for (const t of realTenants) {
    try {
      const agentsBody = (await get(t.agentApiKey, "/v1/agents?limit=100")) as {
        data?: AgentListItem[];
      };
      reachedAny = true;
      const boundNames = new Map<string, string>();
      for (const a of agentsBody.data ?? []) {
        if (a._oma?.runtime_binding?.runtime_id === creds.runtimeId) {
          boundNames.set(a.id, a.name ?? a.id);
        }
      }
      if (boundNames.size === 0) continue;

      const sessionsBody = (await get(
        t.agentApiKey,
        "/v1/sessions?status=running&limit=50",
      )) as { data?: SessionListItem[] };
      for (const s of sessionsBody.data ?? []) {
        if (!boundNames.has(s.agent_id)) continue;
        rows.push({
          id: s.id,
          agentName: boundNames.get(s.agent_id) ?? s.agent?.name ?? s.agent_id,
          status: s.status,
          startedAt: s.created_at ? parseMs(s.created_at) : null,
          lastActivityAt: s.updated_at ? parseMs(s.updated_at) : null,
        });
      }
    } catch {
      skipped += 1;
    }
  }

  // Newest activity first so the most relevant session is on top.
  rows.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));

  if (!reachedAny) {
    return { ok: false, note: "could not reach the server for any workspace", rows: [] };
  }
  const note =
    skipped > 0 ? `${skipped} workspace(s) unreachable — list may be partial` : undefined;
  return { ok: true, note, rows };
}

function parseMs(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}
