/**
 * Console-side Session list/detail row. Differs from
 * `@duyet/oma-api-types`' `SessionMeta` (wire-format) — the
 * list endpoint returns `agent: {id, version}` rather than `agent_id`
 * + `agent_version`, and `title` may be null.
 *
 * Lifted out of SessionsList.tsx so SessionDetail and other consumers
 * can share the shape instead of redefining their own.
 */
export interface SessionRecord {
  id: string;
  title?: string | null;
  agent: { id: string; version: number };
  environment_id: string;
  status?: string;
  created_at: string;
  archived_at?: string;
  terminated_at?: string;
  metadata?: Record<string, unknown>;
  /** Server-computed wall-clock duration (seconds) since creation.
   *  Present on list/SDK responses; absent on create response. */
  stats?: {
    duration_seconds?: number;
  };
  /** Sandbox resource usage. Only populated by GET /:id — the list
   *  endpoint does not overlay live usage yet. */
  sandbox_usage?: {
    instance_type?: string;
    active_seconds: number;
  };
}
