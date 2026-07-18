// Server-side install / deployment phone-home collector.
//
// A running OMA control plane (Cloudflare or self-host Node) reports anonymous
// aggregates about itself on a cron cadence so the project can see how the
// platform is used in the wild. What is collected (and NOTHING else):
//
//   - a random, locally-persisted instance UUID (carries no user data)
//   - the OMA version string + a deployment-kind enum
//   - numeric counts (agents / sessions), durations (ms)
//   - a JSON tally of sandbox-provider launch kinds (provider ids only)
//   - an array of model id strings (names only)
//
// No PII, no prompt/message/content, no tenant/agent names or ids, no file
// paths, no tokens. Every aggregate query is best-effort — a missing/renamed
// table degrades to 0/empty rather than throwing into the scheduler.

import type { SqlClient } from "@duyet/oma-sql-client";

export interface InstallReport {
  instance_id: string;
  oma_version?: string;
  deployment_kind: string;
  agents_total: number;
  agents_active: number;
  sessions_total: number;
  sessions_running: number;
  session_duration_total_ms: number;
  session_duration_avg_ms: number;
  idle_time_total_ms: number;
  sandbox_launches: Record<string, number>;
  model_ids: string[];
}

type EnvLike = Record<string, string | undefined>;

/** Mirrors the CLI opt-out convention (packages/cli/src/telemetry.ts): honored
 *  when OMA_TELEMETRY_DISABLED is truthy, OMA_TELEMETRY is falsy, or
 *  DO_NOT_TRACK is set. */
export function telemetryDisabled(env: EnvLike): boolean {
  const disabled = (env.OMA_TELEMETRY_DISABLED ?? "").toLowerCase();
  if (disabled === "1" || disabled === "true" || disabled === "on" || disabled === "yes") {
    return true;
  }
  const legacy = (env.OMA_TELEMETRY ?? "").toLowerCase();
  if (legacy === "0" || legacy === "false" || legacy === "off" || legacy === "no") return true;
  const dnt = (env.DO_NOT_TRACK ?? "").toLowerCase();
  return dnt === "1" || dnt === "true";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Derive the sandbox-provider kind from a session's environment_snapshot JSON
 *  (fields config.sandbox_provider or legacy config.type; default "cloud").
 *  Returns null for an unparseable snapshot so the caller can skip that row. */
function providerKindFromSnapshot(json: string | null): string | null {
  if (!json) return "cloud";
  try {
    const snap = JSON.parse(json) as { config?: { sandbox_provider?: unknown; type?: unknown } };
    const cfg = snap?.config ?? {};
    const raw = cfg.sandbox_provider ?? cfg.type ?? "cloud";
    const kind = typeof raw === "string" ? raw.toLowerCase() : "cloud";
    // Constrain to the same charset the /ingest schema accepts.
    return /^[a-z0-9-]+$/.test(kind) && kind.length <= 32 ? kind : "cloud";
  } catch {
    return null;
  }
}

/** Extract the model id string from an agent config / agent_snapshot JSON
 *  `model` field (a string, or an object with `.id`). Names only. */
function modelIdFromJson(json: string | null): string | null {
  if (!json) return null;
  try {
    const obj = JSON.parse(json) as { model?: unknown };
    const m = obj?.model;
    let id: string | null = null;
    if (typeof m === "string") id = m;
    else if (m && typeof m === "object" && typeof (m as { id?: unknown }).id === "string") {
      id = (m as { id: string }).id;
    }
    if (!id) return null;
    id = id.trim();
    return id && id.length <= 128 ? id : null;
  } catch {
    return null;
  }
}

/**
 * Collect an anonymous install report from the LOCAL control-plane DB. Every
 * query is wrapped so a missing table (e.g. a partial self-host schema) yields
 * 0/empty rather than throwing.
 */
export async function collectInstallReport(
  sql: SqlClient,
  opts: { instanceId: string; omaVersion?: string; deploymentKind: string },
): Promise<InstallReport> {
  const firstN = async (query: string): Promise<number> => {
    try {
      const row = await sql.prepare(query).first<{ n: number }>();
      return Number(row?.n ?? 0) || 0;
    } catch {
      return 0;
    }
  };

  const agentsTotal = await firstN(`SELECT COUNT(*) AS n FROM agents`);
  const agentsActive = await firstN(`SELECT COUNT(*) AS n FROM agents WHERE archived_at IS NULL`);
  const sessionsTotal = await firstN(`SELECT COUNT(*) AS n FROM sessions`);
  const sessionsRunning = await firstN(
    `SELECT COUNT(*) AS n FROM sessions WHERE status = 'running'`,
  );

  // Durations over FINISHED sessions (terminated_at NOT NULL). Per-session
  // duration = COALESCE(terminated_at, updated_at) - created_at, counted only
  // when positive.
  let durationTotal = 0;
  let durationAvg = 0;
  try {
    const row = await sql
      .prepare(
        `SELECT SUM(dur) AS total, AVG(dur) AS avg FROM (
           SELECT (COALESCE(terminated_at, updated_at) - created_at) AS dur
             FROM sessions
            WHERE terminated_at IS NOT NULL
              AND (COALESCE(terminated_at, updated_at) - created_at) > 0
         )`,
      )
      .first<{ total: number | null; avg: number | null }>();
    durationTotal = Math.round(Number(row?.total ?? 0)) || 0;
    durationAvg = Math.round(Number(row?.avg ?? 0)) || 0;
  } catch {
    /* leave 0 */
  }

  // idle_time_total_ms: the sessions table has no per-session idle accounting
  // column, so this is not cheaply derivable. Report 0 (an honest
  // approximation) rather than inventing a value.
  const idleTimeTotal = 0;

  // sandbox_launches by provider kind — derived from environment_snapshot JSON.
  const sandboxLaunches: Record<string, number> = {};
  try {
    const res = await sql
      .prepare(
        `SELECT environment_snapshot FROM sessions
          WHERE environment_snapshot IS NOT NULL
          ORDER BY created_at DESC LIMIT 5000`,
      )
      .all<{ environment_snapshot: string | null }>();
    for (const r of res.results ?? []) {
      const kind = providerKindFromSnapshot(r.environment_snapshot);
      if (kind) sandboxLaunches[kind] = (sandboxLaunches[kind] ?? 0) + 1;
    }
  } catch {
    /* skip */
  }

  // model_ids — distinct model id strings from agent config + session
  // agent_snapshot JSON. Names only, capped at 64.
  const models = new Set<string>();
  const collectModel = (json: string | null) => {
    const id = modelIdFromJson(json);
    if (id) models.add(id);
  };
  try {
    const res = await sql
      .prepare(`SELECT config FROM agents ORDER BY created_at DESC LIMIT 5000`)
      .all<{ config: string | null }>();
    for (const r of res.results ?? []) collectModel(r.config);
  } catch {
    /* skip */
  }
  try {
    const res = await sql
      .prepare(
        `SELECT agent_snapshot FROM sessions
          WHERE agent_snapshot IS NOT NULL
          ORDER BY created_at DESC LIMIT 5000`,
      )
      .all<{ agent_snapshot: string | null }>();
    for (const r of res.results ?? []) collectModel(r.agent_snapshot);
  } catch {
    /* skip */
  }

  return {
    instance_id: opts.instanceId,
    oma_version: opts.omaVersion,
    deployment_kind: opts.deploymentKind,
    agents_total: agentsTotal,
    agents_active: agentsActive,
    sessions_total: sessionsTotal,
    sessions_running: sessionsRunning,
    session_duration_total_ms: durationTotal,
    session_duration_avg_ms: durationAvg,
    idle_time_total_ms: idleTimeTotal,
    sandbox_launches: sandboxLaunches,
    model_ids: [...models].slice(0, 64),
  };
}

/** Fire-and-forget POST the report to the ingest endpoint. Short 2s timeout;
 *  all errors (offline, DNS, 4xx/5xx, abort) are swallowed. */
export async function sendInstallReport(
  report: InstallReport,
  opts: { endpoint: string },
): Promise<void> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 2000);
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
  try {
    await fetch(`${opts.endpoint.replace(/\/+$/, "")}/v1/telemetry/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report),
      signal: ctl.signal,
    });
  } catch {
    /* best-effort — telemetry must never break the reporter */
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read (or create + persist) a stable anonymous instance id on Node. Persisted
 * at ${XDG_STATE_HOME||~/.local/state}/oma/telemetry-instance-id. Node-only —
 * `node:fs` is lazy-imported so this module stays import-safe on Cloudflare
 * (where the caller passes its own D1-sourced id instead).
 */
export async function resolveInstanceId(): Promise<string> {
  const [fs, os, path, crypto] = await Promise.all([
    import("node:fs"),
    import("node:os"),
    import("node:path"),
    import("node:crypto"),
  ]);

  const stateHome =
    process.env.XDG_STATE_HOME && process.env.XDG_STATE_HOME.length > 0
      ? process.env.XDG_STATE_HOME
      : path.join(os.homedir(), ".local", "state");
  const file = path.join(stateHome, "oma", "telemetry-instance-id");

  try {
    const existing = fs.readFileSync(file, "utf-8").trim();
    if (UUID_RE.test(existing)) return existing;
  } catch {
    /* not created yet */
  }

  const id = crypto.randomUUID();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, id, "utf-8");
  } catch {
    /* best-effort — a non-persisted id still lets this run report */
  }
  return id;
}
