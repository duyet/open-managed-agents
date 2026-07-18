// @ts-nocheck
// Route tests for the tenant teammate-invite flow (issue #175). Drives the
// Hono apps directly against an in-memory `InviteRoutesDeps` fake, so it
// exercises exactly the token/expiry/role/tenant-scoping logic both apps/main
// and apps/main-node wire up — without a real DB.

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  buildTenantMemberRoutes,
  buildInviteAcceptRoutes,
  type InviteRoutesDeps,
  type InviteWithToken,
  type MemberRecord,
} from "./invites";

const TENANT = "tn_a";
const OTHER = "tn_b";

// In-memory backing store shared by both route apps in a test.
function makeStore() {
  const invites = new Map<string, InviteWithToken>();
  const memberships: Array<{ userId: string; tenantId: string; role: string }> = [];
  const roles = new Map<string, string>(); // `${userId}:${tenantId}` -> role
  const emails = new Map<string, string>(); // userId -> email
  const members = new Map<string, MemberRecord[]>(); // tenantId -> list
  const sent: any[] = [];

  const deps: InviteRoutesDeps = {
    authDisabled: false,
    getRole: async (u, t) => roles.get(`${u}:${t}`) ?? null,
    getUserEmail: async (u) => emails.get(u) ?? null,
    listMembers: async (t) => members.get(t) ?? [],
    createInvite: async (rec) => {
      invites.set(rec.id, { ...rec });
    },
    listInvites: async (t, opts) => {
      let items = [...invites.values()]
        .filter((i) => i.tenant_id === t && i.status === "pending")
        .sort((a, b) => b.created_at - a.created_at || (b.id > a.id ? 1 : -1));
      if (opts.after) {
        items = items.filter(
          (i) =>
            i.created_at < opts.after!.createdAt ||
            (i.created_at === opts.after!.createdAt && i.id < opts.after!.id),
        );
      }
      const hasMore = items.length > opts.limit;
      return { items: items.slice(0, opts.limit), hasMore };
    },
    findPendingByEmail: async (t, email) =>
      [...invites.values()].find(
        (i) =>
          i.tenant_id === t &&
          i.email === email &&
          i.status === "pending" &&
          i.expires_at > Date.now(),
      ) ?? null,
    revokeInvite: async (t, id) => {
      const i = invites.get(id);
      if (!i || i.tenant_id !== t || i.status !== "pending") return false;
      i.status = "revoked";
      return true;
    },
    getByToken: async (token) =>
      [...invites.values()].find((i) => i.token === token) ?? null,
    markAccepted: async (id, userId, at) => {
      const i = invites.get(id);
      if (i) {
        i.status = "accepted";
        i.accepted_by = userId;
        i.accepted_at = at;
      }
    },
    addMembership: async (userId, tenantId, role) => {
      memberships.push({ userId, tenantId, role });
      roles.set(`${userId}:${tenantId}`, role);
    },
    sendEmail: async (_c, msg) => {
      sent.push(msg);
    },
    publicBaseUrl: () => "https://oma.test",
  };

  return { deps, invites, memberships, roles, emails, members, sent };
}

function mgmtApp(deps: InviteRoutesDeps, userId?: string, tenantId = TENANT) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("tenant_id", tenantId);
    if (userId) c.set("user_id", userId);
    await next();
  });
  app.route("/", buildTenantMemberRoutes(deps));
  return app;
}

function acceptApp(deps: InviteRoutesDeps, userId?: string) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (userId) c.set("user_id", userId);
    c.set("tenant_id", "ignored");
    await next();
  });
  app.route("/", buildInviteAcceptRoutes(deps));
  return app;
}

const postJson = (app: Hono, path: string, body?: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("tenant invite management routes", () => {
  let s: ReturnType<typeof makeStore>;
  beforeEach(() => {
    s = makeStore();
    s.roles.set(`owner1:${TENANT}`, "owner");
    s.roles.set(`admin1:${TENANT}`, "admin");
    s.roles.set(`member1:${TENANT}`, "member");
  });

  it("owner can create an invite (201) with token + accept_url", async () => {
    const app = mgmtApp(s.deps, "owner1");
    const res = await postJson(app, "/invites", { email: "New@Example.com", role: "admin" });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.id).toMatch(/^inv_/);
    expect(json.email).toBe("new@example.com"); // normalized
    expect(json.role).toBe("admin");
    expect(json.status).toBe("pending");
    expect(json.token).toBeTruthy();
    expect(json.accept_url).toContain("https://oma.test/invites/");
    expect(s.sent).toHaveLength(1);
  });

  it("defaults role to member", async () => {
    const app = mgmtApp(s.deps, "owner1");
    const json = await (await postJson(app, "/invites", { email: "x@e.com" })).json();
    expect(json.role).toBe("member");
  });

  it("a plain member cannot create invites (403 forbidden)", async () => {
    const app = mgmtApp(s.deps, "member1");
    const res = await postJson(app, "/invites", { email: "x@e.com" });
    expect(res.status).toBe(403);
    expect((await res.json()).error.type).toBe("forbidden");
  });

  it("a non-member is rejected (403 not_a_member)", async () => {
    const app = mgmtApp(s.deps, "stranger");
    const res = await postJson(app, "/invites", { email: "x@e.com" });
    expect(res.status).toBe(403);
    expect((await res.json()).error.type).toBe("not_a_member");
  });

  it("rejects an invalid email (422)", async () => {
    const app = mgmtApp(s.deps, "owner1");
    expect((await postJson(app, "/invites", { email: "nope" })).status).toBe(422);
  });

  it("rejects an unknown role (422)", async () => {
    const app = mgmtApp(s.deps, "owner1");
    expect((await postJson(app, "/invites", { email: "x@e.com", role: "owner" })).status).toBe(422);
  });

  it("refuses a duplicate pending invite (409)", async () => {
    const app = mgmtApp(s.deps, "owner1");
    await postJson(app, "/invites", { email: "dup@e.com" });
    const res = await postJson(app, "/invites", { email: "dup@e.com" });
    expect(res.status).toBe(409);
    expect((await res.json()).error.type).toBe("invite_exists");
  });

  it("lists pending invites, revoke removes them", async () => {
    const app = mgmtApp(s.deps, "admin1");
    const created = await (await postJson(app, "/invites", { email: "a@e.com" })).json();
    let list = await (await app.request("/invites")).json();
    expect(list.data).toHaveLength(1);

    const del = await app.request(`/invites/${created.id}`, { method: "DELETE" });
    expect(del.status).toBe(204);
    list = await (await app.request("/invites")).json();
    expect(list.data).toHaveLength(0);
  });

  it("revoking an unknown invite is 404", async () => {
    const app = mgmtApp(s.deps, "owner1");
    expect((await app.request("/invites/inv_missing", { method: "DELETE" })).status).toBe(404);
  });

  it("cannot revoke another tenant's invite", async () => {
    // owner1 owns TENANT only; forge an invite in OTHER.
    s.invites.set("inv_other", {
      id: "inv_other",
      tenant_id: OTHER,
      email: "z@e.com",
      role: "member",
      status: "pending",
      invited_by: "someone",
      created_at: Date.now(),
      expires_at: Date.now() + 1000,
      accepted_at: null,
      accepted_by: null,
      token: "tok_other",
    });
    const app = mgmtApp(s.deps, "owner1", TENANT);
    // scoped revoke on TENANT can't touch OTHER's row → 404, row untouched.
    expect((await app.request("/invites/inv_other", { method: "DELETE" })).status).toBe(404);
    expect(s.invites.get("inv_other")!.status).toBe("pending");
  });

  it("lists members", async () => {
    s.members.set(TENANT, [
      { user_id: "owner1", email: "o@e.com", name: "Owner", role: "owner", created_at: 1 },
    ]);
    const app = mgmtApp(s.deps, "owner1");
    const json = await (await app.request("/members")).json();
    expect(json.data).toHaveLength(1);
    expect(json.data[0].role).toBe("owner");
  });
});

describe("invite accept routes", () => {
  let s: ReturnType<typeof makeStore>;
  beforeEach(() => {
    s = makeStore();
    s.roles.set(`owner1:${TENANT}`, "owner");
  });

  async function createInvite(email: string, role = "member") {
    const app = mgmtApp(s.deps, "owner1");
    return (await postJson(app, "/invites", { email, role })).json();
  }

  it("previews an invite by token", async () => {
    const inv = await createInvite("bob@e.com", "admin");
    const app = acceptApp(s.deps, "bob");
    const json = await (await app.request(`/${inv.token}`)).json();
    expect(json.email).toBe("bob@e.com");
    expect(json.tenant_id).toBe(TENANT);
    expect(json.role).toBe("admin");
    expect(json.expired).toBe(false);
  });

  it("accepts an invite whose email matches the signed-in user", async () => {
    const inv = await createInvite("bob@e.com", "admin");
    s.emails.set("bob", "BOB@e.com"); // case-insensitive match
    const app = acceptApp(s.deps, "bob");
    const res = await postJson(app, `/${inv.token}/accept`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.tenant_id).toBe(TENANT);
    expect(json.role).toBe("admin");
    expect(s.memberships).toContainEqual({ userId: "bob", tenantId: TENANT, role: "admin" });
    expect(s.invites.get(inv.id)!.status).toBe("accepted");
  });

  it("rejects accept when the email does not match (403)", async () => {
    const inv = await createInvite("bob@e.com");
    s.emails.set("mallory", "mallory@e.com");
    const app = acceptApp(s.deps, "mallory");
    const res = await postJson(app, `/${inv.token}/accept`);
    expect(res.status).toBe(403);
    expect((await res.json()).error.type).toBe("email_mismatch");
    expect(s.memberships).toHaveLength(0);
  });

  it("rejects an expired invite (410)", async () => {
    const inv = await createInvite("bob@e.com");
    s.invites.get(inv.id)!.expires_at = Date.now() - 1; // force expiry
    s.emails.set("bob", "bob@e.com");
    const app = acceptApp(s.deps, "bob");
    const res = await postJson(app, `/${inv.token}/accept`);
    expect(res.status).toBe(410);
    expect((await res.json()).error.type).toBe("invite_expired");
  });

  it("rejects a revoked invite (410)", async () => {
    const inv = await createInvite("bob@e.com");
    s.invites.get(inv.id)!.status = "revoked";
    s.emails.set("bob", "bob@e.com");
    const app = acceptApp(s.deps, "bob");
    const res = await postJson(app, `/${inv.token}/accept`);
    expect(res.status).toBe(410);
    expect((await res.json()).error.type).toBe("invite_revoked");
  });

  it("unknown token is 404", async () => {
    const app = acceptApp(s.deps, "bob");
    expect((await app.request("/tok_nope")).status).toBe(404);
    expect((await postJson(app, "/tok_nope/accept")).status).toBe(404);
  });

  it("accept requires a signed-in user (403)", async () => {
    const inv = await createInvite("bob@e.com");
    const app = acceptApp(s.deps); // no user
    expect((await postJson(app, `/${inv.token}/accept`)).status).toBe(403);
  });
});
