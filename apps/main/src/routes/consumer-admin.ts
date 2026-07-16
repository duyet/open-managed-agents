import { Hono } from "hono";
import type { Env } from "@duyet/oma-shared";

// Creator-facing visibility into a publication's end-users (issue #73).
//
// Tenant-authed (mounted under the standard /v1/* auth middleware): lists the
// consumers who have used one of the tenant's publications, with a
// conversation count. Ownership is enforced by matching the publication's
// tenant_id against the authenticated tenant — a creator can only see their
// own publication's users, never another tenant's.

const wrapper = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; user_id?: string };
}>();

wrapper.get("/:id/users", async (c) => {
  const tenantId = c.var.tenant_id;
  const publicationId = c.req.param("id");
  const db = c.env.MAIN_DB;
  if (!db) return c.json({ error: "MAIN_DB not configured" }, 503);

  // Ownership check: the publication must belong to the authed tenant.
  const pub = await db
    .prepare("SELECT tenant_id FROM agent_publication WHERE id = ?")
    .bind(publicationId)
    .first<{ tenant_id: string }>();
  if (!pub || pub.tenant_id !== tenantId) {
    return c.json({ error: "Publication not found" }, 404);
  }

  const limitStr = c.req.query("limit");
  const limit = limitStr ? Math.min(Math.max(1, Number(limitStr)), 100) : 50;

  // conversation_count is derived from sessions stamped with this consumer's
  // id + publication id in metadata; degrades to 0 until that linkage exists.
  const rows = await db
    .prepare(
      `SELECT
         cp.consumer_id AS consumer_id,
         c.name AS name,
         c.auth_provider AS auth_provider,
         cp.first_seen_at AS first_seen_at,
         cp.last_seen_at AS last_seen_at,
         (
           SELECT COUNT(*) FROM sessions s
           WHERE json_extract(s.metadata, '$.end_user_id') = cp.consumer_id
             AND json_extract(s.metadata, '$.publication_id') = cp.publication_id
         ) AS conversation_count
       FROM consumer_publications cp
       JOIN consumers c ON c.id = cp.consumer_id
       WHERE cp.publication_id = ? AND cp.tenant_id = ?
       ORDER BY cp.last_seen_at DESC
       LIMIT ?`,
    )
    .bind(publicationId, tenantId, limit)
    .all<{
      consumer_id: string;
      name: string;
      auth_provider: string;
      first_seen_at: string;
      last_seen_at: string;
      conversation_count: number;
    }>();

  const data = (rows.results ?? []).map((r) => ({
    consumer_id: r.consumer_id,
    name: r.name,
    is_guest: r.auth_provider === "guest",
    first_seen_at: r.first_seen_at,
    last_seen_at: r.last_seen_at,
    conversation_count: Number(r.conversation_count ?? 0),
  }));

  return c.json({ data }, 200);
});

export default wrapper;
