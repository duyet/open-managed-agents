// Tenant teammate invites (issue #175) — the missing "invite a teammate"
// flow. A tenant already carries roles on `membership`, but there was no
// way to add a second person to a workspace. This module adds:
//
//   GET    /v1/tenant/members          list current members
//   GET    /v1/tenant/invites          list pending invites
//   POST   /v1/tenant/invites          create an invite (owner/admin only)
//   DELETE /v1/tenant/invites/:id      revoke a pending invite
//   GET    /v1/invites/:token          preview an invite (authed invitee)
//   POST   /v1/invites/:token/accept   accept — joins the invite's tenant
//
// Data access is injected (the `Deps` below) exactly like buildTenantRoutes'
// `createTenantAndMembership`: CF backs it with env.MAIN_DB (where
// tenant/membership live), self-host Node with its main SqlClient. Invites
// live next to membership/tenant so accept can write a membership row in the
// same store. Delivery is invite-link-first; email is best-effort/optional
// (`sendEmail`) so the flow works with no SMTP configured — the token is
// always returned in the create response.

import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { nanoid } from "nanoid";
import { clampLimit, encodeCursor, decodeCursor } from "@duyet/oma-shared";
import type { PageCursor } from "@duyet/oma-shared";

interface Vars {
  Variables: { tenant_id: string; user_id?: string };
}

/** How long a fresh invite stays acceptable, in ms (7 days). */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Roles a teammate can be invited as. `owner` is reserved for the creator. */
const INVITE_ROLES = ["admin", "member"] as const;
export type InviteRole = (typeof INVITE_ROLES)[number];

/** Roles allowed to manage members + invites. */
const MANAGER_ROLES = new Set(["owner", "admin"]);

export interface InviteRecord {
  id: string;
  tenant_id: string;
  email: string;
  role: string;
  status: "pending" | "accepted" | "revoked";
  invited_by: string | null;
  created_at: number;
  expires_at: number;
  accepted_at: number | null;
  accepted_by: string | null;
}

export interface InviteWithToken extends InviteRecord {
  token: string;
  /** Display name of the target tenant, for the preview screen. */
  tenant_name?: string | null;
}

export interface MemberRecord {
  user_id: string;
  email: string | null;
  name: string | null;
  role: string;
  created_at: number;
}

export interface InviteEmail {
  to: string;
  tenantName: string | null;
  role: string;
  acceptUrl: string;
  token: string;
}

export interface InviteRoutesDeps {
  /** True bypasses the owner/admin gate (AUTH_DISABLED self-host + tests). */
  authDisabled?: boolean;
  /** Caller's role in `tenantId`, or null when not a member. Gates management. */
  getRole(userId: string, tenantId: string): Promise<string | null>;
  /** Resolve the caller's email — needed to match an invite on accept. */
  getUserEmail(userId: string): Promise<string | null>;
  /** List current members of the tenant, ordered (created_at, id) ASC. */
  listMembers(tenantId: string): Promise<MemberRecord[]>;
  /** Persist a new invite row. */
  createInvite(rec: InviteWithToken): Promise<void>;
  /** Page over pending invites, (created_at, id) DESC. */
  listInvites(
    tenantId: string,
    opts: { limit: number; after?: PageCursor },
  ): Promise<{ items: InviteRecord[]; hasMore: boolean }>;
  /** A pending, non-expired invite for this email in this tenant, if any. */
  findPendingByEmail(tenantId: string, email: string): Promise<InviteRecord | null>;
  /** Revoke a pending invite; false when it doesn't exist / isn't pending. */
  revokeInvite(tenantId: string, id: string): Promise<boolean>;
  /** Look up an invite by its opaque token (across tenants). */
  getByToken(token: string): Promise<InviteWithToken | null>;
  /** Mark an invite accepted. */
  markAccepted(id: string, userId: string, at: number): Promise<void>;
  /** Add (or upsert) a membership row. Each runtime picks its own ts unit. */
  addMembership(userId: string, tenantId: string, role: string): Promise<void>;
  /** Best-effort invite email. Absent/throwing = invite-link-only, no failure. */
  sendEmail?(c: Context<Vars>, msg: InviteEmail): Promise<void> | void;
  /** Base URL for the accept link; defaults to the request origin. */
  publicBaseUrl?(c: Context<Vars>): string | undefined;
}

const createSchema = z.object({
  email: z.string().email().max(320),
  role: z.enum(INVITE_ROLES).optional().default("member"),
});

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function acceptUrl(c: Context<Vars>, deps: InviteRoutesDeps, token: string): string {
  const base =
    (deps.publicBaseUrl && deps.publicBaseUrl(c)) || new URL(c.req.url).origin;
  return `${base.replace(/\/$/, "")}/invites/${token}`;
}

function toApiInvite(rec: InviteRecord, extra?: Record<string, unknown>) {
  return {
    id: rec.id,
    email: rec.email,
    role: rec.role,
    status: rec.status,
    invited_by: rec.invited_by,
    created_at: rec.created_at,
    expires_at: rec.expires_at,
    accepted_at: rec.accepted_at,
    ...extra,
  };
}

/** Members + invite management, scoped to the caller's active tenant.
 *  Mount at /v1/tenant. */
export function buildTenantMemberRoutes(deps: InviteRoutesDeps) {
  const app = new Hono<Vars>();

  // Owner/admin gate shared by every management route. Returns the caller's
  // user id on success, or a Response to short-circuit.
  const requireManager = async (
    c: Context<Vars>,
  ): Promise<string | Response> => {
    const tenantId = c.var.tenant_id;
    const userId = c.var.user_id;
    if (deps.authDisabled) return userId ?? "default";
    if (!userId) {
      return c.json({ error: "Cookie session required" }, 403);
    }
    const role = await deps.getRole(userId, tenantId);
    if (!role) {
      return c.json(
        { type: "error", error: { type: "not_a_member", message: "Not a member" } },
        403,
      );
    }
    if (!MANAGER_ROLES.has(role)) {
      return c.json(
        {
          type: "error",
          error: {
            type: "forbidden",
            message: "Only workspace owners and admins can manage members",
          },
        },
        403,
      );
    }
    return userId;
  };

  app.get("/members", async (c) => {
    const gate = await requireManager(c);
    if (typeof gate !== "string") return gate;
    const members = await deps.listMembers(c.var.tenant_id);
    return c.json({ data: members });
  });

  app.get("/invites", async (c) => {
    const gate = await requireManager(c);
    if (typeof gate !== "string") return gate;
    const limit = clampLimit(Number(c.req.query("limit")) || undefined);
    const after = decodeCursor(c.req.query("cursor"));
    const { items, hasMore } = await deps.listInvites(c.var.tenant_id, { limit, after });
    const nextCursor =
      hasMore && items.length > 0
        ? encodeCursor({
            createdAt: items[items.length - 1].created_at,
            id: items[items.length - 1].id,
          })
        : null;
    return c.json({ data: items.map((i) => toApiInvite(i)), next_cursor: nextCursor });
  });

  app.post("/invites", async (c) => {
    const gate = await requireManager(c);
    if (typeof gate !== "string") return gate;
    const invitedBy = gate;
    const tenantId = c.var.tenant_id;

    const raw = await c.req.json().catch(() => null);
    const parsed = createSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid invite", details: parsed.error.flatten() },
        422,
      );
    }
    const email = normalizeEmail(parsed.data.email);
    const role = parsed.data.role;

    // Idempotent-ish: reuse the pending invite for a re-invited address so a
    // double-send doesn't produce two live tokens for the same person.
    const existing = await deps.findPendingByEmail(tenantId, email);
    if (existing) {
      return c.json(
        {
          type: "error",
          error: {
            type: "invite_exists",
            message: "A pending invite already exists for this email",
          },
        },
        409,
      );
    }

    const now = Date.now();
    const rec: InviteWithToken = {
      id: `inv_${nanoid(16)}`,
      tenant_id: tenantId,
      email,
      role,
      status: "pending",
      invited_by: invitedBy,
      created_at: now,
      expires_at: now + INVITE_TTL_MS,
      accepted_at: null,
      accepted_by: null,
      token: nanoid(40),
    };
    await deps.createInvite(rec);

    const url = acceptUrl(c, deps, rec.token);
    if (deps.sendEmail) {
      try {
        await deps.sendEmail(c, {
          to: email,
          tenantName: null,
          role,
          acceptUrl: url,
          token: rec.token,
        });
      } catch {
        // best-effort — the invite link in the response still works.
      }
    }

    return c.json(
      { ...toApiInvite(rec, { token: rec.token, accept_url: url }) },
      201,
    );
  });

  app.delete("/invites/:id", async (c) => {
    const gate = await requireManager(c);
    if (typeof gate !== "string") return gate;
    const ok = await deps.revokeInvite(c.var.tenant_id, c.req.param("id"));
    if (!ok) return c.json({ error: "not found" }, 404);
    return c.body(null, 204);
  });

  return app;
}

/** Invite preview + accept, keyed by the opaque token. Mount at /v1/invites.
 *  Both routes require a cookie session (the invitee must be signed in). */
export function buildInviteAcceptRoutes(deps: InviteRoutesDeps) {
  const app = new Hono<Vars>();

  const loadValid = async (c: Context<Vars>) => {
    const token = c.req.param("token");
    if (!token) return null;
    const invite = await deps.getByToken(token);
    return invite;
  };

  app.get("/:token", async (c) => {
    const invite = await loadValid(c);
    if (!invite) return c.json({ error: "not found" }, 404);
    const expired = invite.status === "pending" && invite.expires_at <= Date.now();
    return c.json({
      email: invite.email,
      tenant_id: invite.tenant_id,
      tenant_name: invite.tenant_name ?? null,
      role: invite.role,
      status: invite.status,
      expires_at: invite.expires_at,
      expired,
    });
  });

  app.post("/:token/accept", async (c) => {
    const userId = c.var.user_id;
    if (!userId && !deps.authDisabled) {
      return c.json({ error: "Cookie session required to accept an invite" }, 403);
    }
    const invite = await loadValid(c);
    if (!invite) return c.json({ error: "not found" }, 404);

    if (invite.status === "revoked") {
      return c.json(
        { type: "error", error: { type: "invite_revoked", message: "This invite was revoked" } },
        410,
      );
    }
    if (invite.status === "pending" && invite.expires_at <= Date.now()) {
      return c.json(
        { type: "error", error: { type: "invite_expired", message: "This invite has expired" } },
        410,
      );
    }

    // Match the signed-in user's email to the invite. Skipped only under
    // AUTH_DISABLED where there is no real user identity.
    const uid = userId ?? "default";
    if (!deps.authDisabled) {
      const email = await deps.getUserEmail(uid);
      if (!email || normalizeEmail(email) !== invite.email) {
        return c.json(
          {
            type: "error",
            error: {
              type: "email_mismatch",
              message: "This invite was sent to a different email address",
            },
          },
          403,
        );
      }
    }

    await deps.addMembership(uid, invite.tenant_id, invite.role);
    if (invite.status === "pending") {
      await deps.markAccepted(invite.id, uid, Date.now());
    }

    return c.json({ tenant_id: invite.tenant_id, role: invite.role, status: "accepted" });
  });

  return app;
}
