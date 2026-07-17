// GitHubProvider.beginManagedWorkspaceInstall / completeManagedWorkspaceInstall
// — the workspace-level "Connect" flow. Installs this deployment's managed
// GitHub App onto a user's org WITHOUT binding an agent first: the callback
// records ONLY a github_installations row + credential vault (no publication,
// no github_apps row).

import { describe, expect, it } from "vitest";
import { GitHubProvider } from "./provider";
import { buildFakeGitHubContainer } from "./test-fakes";
import type { GitHubConfig } from "./config";

const MANAGED_APP = {
  appId: "123456",
  appSlug: "oma-managed-bot",
  botLogin: "oma-managed-bot[bot]",
  // Filled per-test with a freshly generated PKCS#8 PEM (mintAppJwt needs a
  // real RSA key to RS256-sign the App JWT).
  privateKey: "",
  webhookSecret: "MANAGED_WEBHOOK_SECRET",
};

function baseConfig(managedApp: GitHubConfig["managedApp"]): GitHubConfig {
  return {
    gatewayOrigin: "https://gw.example.com",
    defaultCapabilities: ["issue.read"],
    mcpServerUrl: "https://api.githubcopilot.com/mcp/",
    managedApp,
  };
}

/** Generate a PKCS#8 RSA PEM (the format mintAppJwt's importKey expects). */
async function generatePkcs8Pem(): Promise<string> {
  const kp = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = (await crypto.subtle.exportKey("pkcs8", kp.privateKey)) as ArrayBuffer;
  const bytes = new Uint8Array(pkcs8);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin);
  const lines = b64.match(/.{1,64}/g)?.join("\n") ?? b64;
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n`;
}

const RETURN_URL = "https://console.example.com/integrations/github";

describe("GitHubProvider.beginManagedWorkspaceInstall", () => {
  it("throws a clear error when no managed App is configured", async () => {
    const container = buildFakeGitHubContainer();
    const provider = new GitHubProvider(container, baseConfig(null));

    await expect(
      provider.beginManagedWorkspaceInstall({
        userId: "user_1",
        returnUrl: RETURN_URL,
      }),
    ).rejects.toThrow(/no managed App configured/i);
  });

  it("returns an install URL carrying a workspace-kind state", async () => {
    const container = buildFakeGitHubContainer();
    const provider = new GitHubProvider(container, baseConfig(MANAGED_APP));

    const { url } = await provider.beginManagedWorkspaceInstall({
      userId: "user_1",
      returnUrl: RETURN_URL,
    });

    expect(url).toContain("github.com/apps/oma-managed-bot/installations/new");
    const state = new URL(url).searchParams.get("state");
    expect(state).toBeTruthy();

    // No publication or installation is created up front — that only happens
    // on the install callback.
    const installs = await container.installations.listByUser("user_1", "github");
    expect(installs.length).toBe(0);

    // The state decodes to the workspace kind + carries userId/returnUrl.
    const decoded = await container.jwt.verify<{
      kind: string;
      userId: string;
      returnUrl: string;
      tenantId: string;
    }>(state!);
    expect(decoded.kind).toBe("github.install.workspace");
    expect(decoded.userId).toBe("user_1");
    expect(decoded.returnUrl).toBe(RETURN_URL);
    expect(decoded.tenantId).toBeTruthy();
  });
});

describe("GitHubProvider.completeManagedWorkspaceInstall", () => {
  async function beginState(
    provider: GitHubProvider,
    container: ReturnType<typeof buildFakeGitHubContainer>,
  ): Promise<string> {
    const { url } = await provider.beginManagedWorkspaceInstall({
      userId: "user_1",
      returnUrl: RETURN_URL,
    });
    return new URL(url).searchParams.get("state")!;
  }

  function queueInstallCallbackHttp(
    container: ReturnType<typeof buildFakeGitHubContainer>,
  ): void {
    // 1) Installation token mint. 2) GET installation detail.
    container.http.respondWith(
      {
        status: 201,
        headers: {},
        body: JSON.stringify({
          token: "ghs_installation_token",
          expires_at: "2026-01-01T00:00:00Z",
          permissions: { contents: "write", issues: "write" },
          repository_selection: "all",
        }),
      },
      {
        status: 200,
        headers: {},
        body: JSON.stringify({
          id: 42,
          account: { id: 7, login: "acme", type: "Organization", avatar_url: null },
          repository_selection: "all",
          app_id: 123456,
          permissions: { contents: "write", issues: "write" },
          events: [],
        }),
      },
    );
  }

  it("records an installation + vault and returns the org login", async () => {
    const container = buildFakeGitHubContainer();
    const managedApp = { ...MANAGED_APP, privateKey: await generatePkcs8Pem() };
    const provider = new GitHubProvider(container, baseConfig(managedApp));
    const state = await beginState(provider, container);
    queueInstallCallbackHttp(container);

    const result = await provider.completeManagedWorkspaceInstall({
      installationId: "555000",
      state,
    });

    expect(result.returnUrl).toBe(RETURN_URL);
    expect(result.login).toBe("acme");

    // First-class installation row, no publication, appId=null (no
    // github_apps row for managed workspace installs).
    const installs = await container.installations.listByUser("user_1", "github");
    expect(installs.length).toBe(1);
    expect(installs[0].workspaceId).toBe("555000");
    expect(installs[0].workspaceName).toBe("acme");
    expect(installs[0].appId).toBeNull();
    expect(installs[0].botUserId).toBe("oma-managed-bot[bot]");
    expect(installs[0].vaultId).toBeTruthy();

    // One vault with both surfaces: static_bearer (MCP) + cap_cli id="gh".
    expect(container.vaults.created.length).toBe(1);
    expect(container.vaults.created[0].bearerToken).toBe("ghs_installation_token");
    expect(container.vaults.capCli.length).toBe(1);
    expect(container.vaults.capCli[0].cliId).toBe("gh");
  });

  it("is idempotent — a repeat callback reuses the live install, no second vault", async () => {
    const container = buildFakeGitHubContainer();
    const managedApp = { ...MANAGED_APP, privateKey: await generatePkcs8Pem() };
    const provider = new GitHubProvider(container, baseConfig(managedApp));
    const state = await beginState(provider, container);
    queueInstallCallbackHttp(container);

    await provider.completeManagedWorkspaceInstall({ installationId: "555000", state });
    // No new HTTP responses queued — a second call must short-circuit before
    // minting a token (findByWorkspace reuse).
    const second = await provider.completeManagedWorkspaceInstall({
      installationId: "555000",
      state,
    });

    expect(second.login).toBe("acme");
    const installs = await container.installations.listByUser("user_1", "github");
    expect(installs.length).toBe(1);
    expect(container.vaults.created.length).toBe(1);
  });

  it("rejects a wrong-kind state", async () => {
    const container = buildFakeGitHubContainer();
    const managedApp = { ...MANAGED_APP, privateKey: await generatePkcs8Pem() };
    const provider = new GitHubProvider(container, baseConfig(managedApp));

    // A publication-flow state, not a workspace one.
    const wrongState = await container.jwt.sign(
      {
        kind: "github.install.pub",
        publicationId: "pub_1",
        userId: "user_1",
        returnUrl: RETURN_URL,
      },
      3600,
    );

    await expect(
      provider.completeManagedWorkspaceInstall({
        installationId: "555000",
        state: wrongState,
      }),
    ).rejects.toThrow(/invalid state kind/i);
  });

  it("throws when no managed App is configured", async () => {
    const container = buildFakeGitHubContainer();
    const provider = new GitHubProvider(container, baseConfig(null));
    const wrongState = await container.jwt.sign(
      { kind: "github.install.workspace", userId: "user_1", returnUrl: RETURN_URL },
      3600,
    );

    await expect(
      provider.completeManagedWorkspaceInstall({
        installationId: "555000",
        state: wrongState,
      }),
    ).rejects.toThrow(/no managed App configured/i);
  });
});
