// Route-level coverage for the GitHub issues-board proxies backing the
// Console Kanban "GitHub Issues" tab. These endpoints resolve the path
// installation (ownership + vault checked) and forward to the gateway's
// /github/internal/* routes with the internal secret. The token mint +
// GitHub REST call live in the gateway; here we only verify the resolve +
// forward contract (ownership 404, missing-vault 409, forwarded body shape).

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { InMemoryInstallationRepo } from "@duyet/oma-integrations-core/test-fakes";
import {
  buildIntegrationsRoutes,
  type IntegrationsBags,
  type InstallProxyForwarder,
} from "./index";

const USER = "user-a";
const OTHER_USER = "user-b";

function makeInstallation(repo: InMemoryInstallationRepo, opts: { userId: string; withVault: boolean }) {
  return repo
    .insert({
      tenantId: "tenant-a",
      userId: opts.userId,
      providerId: "github",
      workspaceId: "999",
      workspaceName: "acme",
      installKind: "dedicated",
      appId: "app_1",
      botUserId: "bot_1",
      accessToken: "ghs_seed",
      refreshToken: null,
      scopes: [],
    })
    .then(async (inst) => {
      if (opts.withVault) await repo.setVaultId(inst.id, "vlt_1");
      return inst;
    });
}

/** Records what the route forwarded so tests can assert the wire shape. */
function recordingProxy(): {
  proxy: InstallProxyForwarder;
  calls: Array<{ subpath: string; body: unknown; needsInternalSecret: boolean }>;
} {
  const calls: Array<{ subpath: string; body: unknown; needsInternalSecret: boolean }> = [];
  const proxy: InstallProxyForwarder = {
    async forward({ subpath, body, needsInternalSecret }) {
      calls.push({ subpath, body, needsInternalSecret });
      return new Response(JSON.stringify({ data: [], ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
  return { proxy, calls };
}

function buildApp(repo: InMemoryInstallationRepo, proxy: InstallProxyForwarder | null, userId = USER) {
  const bags: IntegrationsBags = {
    linear: null,
    slack: null,
    github: {
      installations: repo,
      // Only `installations` is exercised by the board routes.
      publications: {} as never,
    },
  };
  const routes = buildIntegrationsRoutes({ bags: () => bags, installProxy: proxy });
  const wrapper = new Hono<{ Variables: { tenant_id: string; user_id?: string } }>();
  wrapper.use("*", async (c, next) => {
    c.set("tenant_id", "tenant-a");
    c.set("user_id", userId);
    await next();
  });
  wrapper.route("/", routes);
  return wrapper;
}

describe("GitHub issues board proxies", () => {
  it("forwards a repos request to github/internal/list-repos with the vault id", async () => {
    const repo = new InMemoryInstallationRepo();
    const inst = await makeInstallation(repo, { userId: USER, withVault: true });
    const { proxy, calls } = recordingProxy();
    const app = buildApp(repo, proxy);

    const res = await app.request(`/github/installations/${inst.id}/repos?page=2`);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].subpath).toBe("github/internal/list-repos");
    expect(calls[0].needsInternalSecret).toBe(true);
    expect(calls[0].body).toMatchObject({ userId: USER, vaultId: "vlt_1", page: 2 });
  });

  it("forwards an issues request with parsed repo slug + filters", async () => {
    const repo = new InMemoryInstallationRepo();
    const inst = await makeInstallation(repo, { userId: USER, withVault: true });
    const { proxy, calls } = recordingProxy();
    const app = buildApp(repo, proxy);

    const res = await app.request(
      `/github/installations/${inst.id}/issues?repo=acme%2Fwidgets&state=closed&labels=bug,ui&assignee=octocat&q=crash`,
    );
    expect(res.status).toBe(200);
    expect(calls[0].subpath).toBe("github/internal/list-issues");
    expect(calls[0].body).toMatchObject({
      userId: USER,
      vaultId: "vlt_1",
      owner: "acme",
      repo: "widgets",
      state: "closed",
      labels: ["bug", "ui"],
      assignee: "octocat",
      q: "crash",
      page: 1,
    });
  });

  it("404s when the installation belongs to another user", async () => {
    const repo = new InMemoryInstallationRepo();
    const inst = await makeInstallation(repo, { userId: OTHER_USER, withVault: true });
    const { proxy, calls } = recordingProxy();
    const app = buildApp(repo, proxy); // request runs as USER

    const res = await app.request(`/github/installations/${inst.id}/repos`);
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("409s when the installation has no connected vault", async () => {
    const repo = new InMemoryInstallationRepo();
    const inst = await makeInstallation(repo, { userId: USER, withVault: false });
    const { proxy, calls } = recordingProxy();
    const app = buildApp(repo, proxy);

    const res = await app.request(`/github/installations/${inst.id}/issues?repo=acme/widgets`);
    expect(res.status).toBe(409);
    expect(calls).toHaveLength(0);
  });
});
