// Unit tests for SlackProvider's install/OAuth-callback surface:
//
//   - startManagedInstall — the "Add to Slack" one-click flow (issue #89).
//     Skips the BYOA credentials form by staging this deployment's managed
//     App credentials, and returns the Slack authorize URL directly.
//   - completeInstall (exercised via continueInstall's "oauth_callback_pub"
//     payload) — the OAuth callback route's actual logic
//     (`/slack/oauth/pub/:pubId/callback` in packages/http-routes calls
//     exactly this). Mocks Slack's token-exchange HTTP call so no network
//     traffic happens.
//
// No Slack-specific in-memory fakes exist yet in
// @duyet/oma-integrations-core/test-fakes (it only ships the Linear-shaped
// PublicationRepo fake), so this file hand-rolls minimal Slack port fakes
// on top of the shared ones (clock/ids/crypto/jwt/http/tenants/vaults).

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildFakeContainer,
  InMemoryInstallationRepo,
  type FakeContainer,
} from "@duyet/oma-integrations-core/test-fakes";
import type {
  CapabilitySet,
  Persona,
  Publication,
  SessionGranularity,
} from "@duyet/oma-integrations-core";
import { SlackProvider, type SlackContainer } from "./provider";
import type {
  SlackInstallationRepo,
  SlackPublicationCredentialState,
  SlackPublicationRepo,
} from "./ports";

// ─── Minimal Slack port fakes ───────────────────────────────────────────

class FakeSlackInstallationRepo extends InMemoryInstallationRepo implements SlackInstallationRepo {
  private userTokens = new Map<string, string>();
  private botVaultIds = new Map<string, string>();

  async getUserToken(id: string): Promise<string | null> {
    return this.userTokens.get(id) ?? null;
  }
  async setUserToken(id: string, userToken: string): Promise<void> {
    this.userTokens.set(id, userToken);
  }
  async setBotVaultId(id: string, botVaultId: string): Promise<void> {
    this.botVaultIds.set(id, botVaultId);
  }
  async getBotVaultId(id: string): Promise<string | null> {
    return this.botVaultIds.get(id) ?? null;
  }
}

interface FakeSlackPublicationRow extends Publication {
  clientId: string | null;
  clientSecretPlain: string | null;
  signingSecretPlain: string | null;
  slackAppId: string | null;
}

class FakeSlackPublicationRepo implements SlackPublicationRepo {
  private rows = new Map<string, FakeSlackPublicationRow>();
  private seq = 0;

  async insertShell(input: {
    tenantId: string;
    userId: string;
    agentId: string;
    environmentId: string;
    persona: Persona;
    capabilities: CapabilitySet;
    sessionGranularity: SessionGranularity;
  }): Promise<Publication> {
    this.seq += 1;
    const row: FakeSlackPublicationRow = {
      id: `pub_${this.seq}`,
      tenantId: input.tenantId,
      userId: input.userId,
      agentId: input.agentId,
      installationId: "",
      environmentId: input.environmentId,
      mode: "full",
      status: "pending_setup",
      persona: input.persona,
      capabilities: input.capabilities,
      sessionGranularity: input.sessionGranularity,
      createdAt: 0,
      unpublishedAt: null,
      clientId: null,
      clientSecretPlain: null,
      signingSecretPlain: null,
      slackAppId: null,
    };
    this.rows.set(row.id, row);
    return row;
  }

  async setCredentials(
    publicationId: string,
    input: { clientId: string; clientSecretCipher: string; signingSecretCipher: string },
  ): Promise<void> {
    const row = this.rows.get(publicationId);
    if (!row) throw new Error(`FakeSlackPublicationRepo: unknown publication ${publicationId}`);
    // Tests use FakeCrypto (`enc(...)` wrap) — decrypt here so
    // getClientSecret/getSigningSecret can return plaintext without
    // depending on a Crypto instance in this fake.
    row.clientId = input.clientId;
    row.clientSecretPlain = unwrapFakeCipher(input.clientSecretCipher);
    row.signingSecretPlain = unwrapFakeCipher(input.signingSecretCipher);
    if (row.status === "pending_setup") row.status = "credentials_filled";
  }

  async getClientSecret(publicationId: string): Promise<string | null> {
    return this.rows.get(publicationId)?.clientSecretPlain ?? null;
  }

  async getSigningSecret(publicationId: string): Promise<string | null> {
    return this.rows.get(publicationId)?.signingSecretPlain ?? null;
  }

  async getCredentialState(publicationId: string): Promise<SlackPublicationCredentialState | null> {
    const row = this.rows.get(publicationId);
    if (!row) return null;
    return {
      clientId: row.clientId,
      hasClientSecret: row.clientSecretPlain !== null,
      hasSigningSecret: row.signingSecretPlain !== null,
      slackAppId: row.slackAppId,
    };
  }

  async bindInstallation(input: {
    publicationId: string;
    installationId: string;
    slackAppId: string;
  }): Promise<void> {
    const row = this.rows.get(input.publicationId);
    if (!row) throw new Error(`FakeSlackPublicationRepo: unknown publication ${input.publicationId}`);
    row.installationId = input.installationId;
    row.slackAppId = input.slackAppId;
    row.status = "live";
  }

  async findBySlackAppId(slackAppId: string): Promise<Publication | null> {
    for (const row of this.rows.values()) {
      if (row.slackAppId === slackAppId) return row;
    }
    return null;
  }

  // ─── base PublicationRepo ─────────────────────────────────────────
  async get(id: string): Promise<Publication | null> {
    return this.rows.get(id) ?? null;
  }
  async listByInstallation(installationId: string): Promise<ReadonlyArray<Publication>> {
    return [...this.rows.values()].filter((r) => r.installationId === installationId);
  }
  async listByUserAndAgent(userId: string, agentId: string): Promise<ReadonlyArray<Publication>> {
    return [...this.rows.values()].filter((r) => r.userId === userId && r.agentId === agentId);
  }
  async listPendingByUser(userId: string): Promise<ReadonlyArray<Publication>> {
    return [...this.rows.values()].filter(
      (r) =>
        r.userId === userId &&
        (r.status === "pending_setup" || r.status === "credentials_filled" || r.status === "awaiting_install"),
    );
  }
  async insert(): Promise<Publication> {
    throw new Error("FakeSlackPublicationRepo.insert: not used by publication-first flow");
  }
  async updateStatus(id: string, status: Publication["status"]): Promise<void> {
    const row = this.rows.get(id);
    if (row) row.status = status;
  }
  async updateCapabilities(id: string, capabilities: CapabilitySet): Promise<void> {
    const row = this.rows.get(id);
    if (row) row.capabilities = capabilities;
  }
  async updatePersona(id: string, persona: Persona): Promise<void> {
    const row = this.rows.get(id);
    if (row) row.persona = persona;
  }
  async markUnpublished(id: string, at: number): Promise<void> {
    const row = this.rows.get(id);
    if (row) {
      row.status = "unpublished";
      row.unpublishedAt = at;
    }
  }
}

function unwrapFakeCipher(ciphertext: string): string {
  if (!ciphertext.startsWith("enc(") || !ciphertext.endsWith(")")) {
    throw new Error(`unwrapFakeCipher: not a fake-cipher: ${ciphertext}`);
  }
  return ciphertext.slice(4, -1);
}

// ─── Test harness ────────────────────────────────────────────────────

function buildSlackTestContainer(): {
  base: FakeContainer;
  container: SlackContainer;
  slackInstallations: FakeSlackInstallationRepo;
  slackPublications: FakeSlackPublicationRepo;
} {
  const base = buildFakeContainer();
  const slackInstallations = new FakeSlackInstallationRepo(base.clock);
  const slackPublications = new FakeSlackPublicationRepo();
  const container: SlackContainer = {
    ...base,
    installations: slackInstallations,
    publications: slackPublications,
    sessionScopes: base.sessionScopes as unknown as SlackContainer["sessionScopes"],
  };
  return { base, container, slackInstallations, slackPublications };
}

const PERSONA: Persona = { name: "Coder", avatarUrl: null };

describe("SlackProvider.startManagedInstall", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("no network access in unit tests")),
    );
  });

  it("throws a clear error when no managed App is configured", async () => {
    const { container } = buildSlackTestContainer();
    const provider = new SlackProvider(container, {
      gatewayOrigin: "https://gw.example.com",
      botScopes: ["chat:write"],
      userScopes: ["search:read.public"],
      defaultCapabilities: ["message.write"],
      managedApp: null,
    });

    await expect(
      provider.startManagedInstall({
        userId: "user_1",
        agentId: "agent_1",
        environmentId: "env_1",
        mode: "full",
        persona: PERSONA,
        returnUrl: "https://console.example.com/integrations/slack",
      }),
    ).rejects.toThrow(/no managed App configured/i);
  });

  it("stages managed credentials and returns the Slack authorize URL directly", async () => {
    const { base, container, slackPublications } = buildSlackTestContainer();
    const provider = new SlackProvider(container, {
      gatewayOrigin: "https://gw.example.com",
      botScopes: ["chat:write", "app_mentions:read"],
      userScopes: ["search:read.public"],
      defaultCapabilities: ["message.write"],
      managedApp: {
        clientId: "MANAGED_CLIENT_ID",
        clientSecret: "MANAGED_CLIENT_SECRET",
        signingSecret: "MANAGED_SIGNING_SECRET",
      },
    });

    const result = await provider.startManagedInstall({
      userId: "user_1",
      agentId: "agent_1",
      environmentId: "env_1",
      mode: "full",
      persona: PERSONA,
      returnUrl: "https://console.example.com/integrations/slack",
    });

    expect(result.kind).toBe("step");
    expect(result.step).toBe("install_link");
    const data = result.data as { url: string; publicationId: string };
    expect(data.publicationId).toBeTruthy();

    // Authorize URL carries the managed client id + configured scopes, no
    // user-pasted credentials involved.
    const url = new URL(data.url);
    expect(url.origin + url.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(url.searchParams.get("client_id")).toBe("MANAGED_CLIENT_ID");
    expect(url.searchParams.get("scope")).toBe("chat:write,app_mentions:read");
    expect(url.searchParams.get("state")).toBeTruthy();

    // Credentials were staged on the publication row and it's ready for
    // OAuth (not sitting at pending_setup waiting on a form).
    const credState = await slackPublications.getCredentialState(data.publicationId);
    expect(credState?.clientId).toBe("MANAGED_CLIENT_ID");
    expect(credState?.hasClientSecret).toBe(true);
    expect(credState?.hasSigningSecret).toBe(true);
    const pub = await slackPublications.get(data.publicationId);
    expect(pub?.status).toBe("awaiting_install");
  });
});

describe("SlackProvider OAuth callback (completeInstall via continueInstall)", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("no network access in unit tests")),
    );
  });

  function tokenExchangeResponseBody(): string {
    return JSON.stringify({
      ok: true,
      access_token: "xoxb-bot-token",
      token_type: "bot",
      scope: "chat:write,app_mentions:read",
      bot_user_id: "UBOT123",
      app_id: "A0MANAGED",
      team: { id: "T0TEAM", name: "Acme Corp" },
      enterprise: null,
      authed_user: {
        id: "U0INSTALLER",
        scope: "search:read.public",
        access_token: "xoxp-user-token",
        token_type: "user",
      },
    });
  }

  it("exchanges the code, materializes the installation + vaults, and flips the publication live", async () => {
    const { base, container, slackInstallations, slackPublications } = buildSlackTestContainer();
    base.tenants.set("user_1", "tn_acme");

    const provider = new SlackProvider(container, {
      gatewayOrigin: "https://gw.example.com",
      botScopes: ["chat:write", "app_mentions:read"],
      userScopes: ["search:read.public"],
      defaultCapabilities: ["message.write"],
      managedApp: {
        clientId: "MANAGED_CLIENT_ID",
        clientSecret: "MANAGED_CLIENT_SECRET",
        signingSecret: "MANAGED_SIGNING_SECRET",
      },
    });

    // Step 1: kick off the managed install to get a real publicationId +
    // state token wired the same way the route handler produces them.
    const startResult = await provider.startManagedInstall({
      userId: "user_1",
      agentId: "agent_1",
      environmentId: "env_1",
      mode: "full",
      persona: PERSONA,
      returnUrl: "https://console.example.com/integrations/slack",
    });
    const { url, publicationId } = startResult.data as { url: string; publicationId: string };
    const state = new URL(url).searchParams.get("state")!;

    // Step 2: mock Slack's token-exchange HTTP call — the callback route's
    // actual work. Also stub the best-effort auth.test sanity check.
    base.http
      .respondWith({ status: 200, headers: {}, body: tokenExchangeResponseBody() })
      .respondWith({ status: 200, headers: {}, body: JSON.stringify({ ok: true }) });

    const result = await provider.continueInstall({
      publicationId: null,
      payload: {
        kind: "oauth_callback_pub",
        publicationId,
        code: "oauth-code-123",
        state,
      },
    });

    expect(result.kind).toBe("complete");
    expect((result as { publicationId: string }).publicationId).toBe(publicationId);

    // Publication flipped live.
    const pub = await slackPublications.get(publicationId);
    expect(pub?.status).toBe("live");

    // Token-exchange request hit the right URL with the managed secret.
    const tokenReq = base.http.calls[0];
    expect(tokenReq.url).toBe("https://slack.com/api/oauth.v2.access");
    expect(tokenReq.body).toContain("client_id=MANAGED_CLIENT_ID");
    expect(tokenReq.body).toContain("client_secret=MANAGED_CLIENT_SECRET");
    expect(tokenReq.body).toContain("code=oauth-code-123");

    // Installation materialized with the bot token + team info.
    const installations = await slackInstallations.listByUser("user_1", "slack");
    expect(installations).toHaveLength(1);
    const installation = installations[0]!;
    expect(installation.workspaceId).toBe("T0TEAM");
    expect(installation.workspaceName).toBe("Acme Corp");
    expect(installation.botUserId).toBe("UBOT123");
    await expect(slackInstallations.getAccessToken(installation.id)).resolves.toBe("xoxb-bot-token");
    await expect(slackInstallations.getUserToken(installation.id)).resolves.toBe("xoxp-user-token");

    // Both vaults created (user token for MCP, bot token for direct API).
    expect(base.vaults.created).toHaveLength(2);
    expect(installation.vaultId).toBeTruthy();
    await expect(slackInstallations.getBotVaultId(installation.id)).resolves.toBeTruthy();
  });

  it("is idempotent — retrying a callback for an already-live publication short-circuits without re-exchanging the code", async () => {
    const { base, container, slackPublications } = buildSlackTestContainer();
    base.tenants.set("user_1", "tn_acme");
    const provider = new SlackProvider(container, {
      gatewayOrigin: "https://gw.example.com",
      botScopes: ["chat:write"],
      userScopes: ["search:read.public"],
      defaultCapabilities: ["message.write"],
      managedApp: {
        clientId: "MANAGED_CLIENT_ID",
        clientSecret: "MANAGED_CLIENT_SECRET",
        signingSecret: "MANAGED_SIGNING_SECRET",
      },
    });

    const startResult = await provider.startManagedInstall({
      userId: "user_1",
      agentId: "agent_1",
      environmentId: "env_1",
      mode: "full",
      persona: PERSONA,
      returnUrl: "https://console.example.com/integrations/slack",
    });
    const { url, publicationId } = startResult.data as { url: string; publicationId: string };
    const state = new URL(url).searchParams.get("state")!;

    base.http
      .respondWith({ status: 200, headers: {}, body: tokenExchangeResponseBody() })
      .respondWith({ status: 200, headers: {}, body: JSON.stringify({ ok: true }) });

    await provider.continueInstall({
      publicationId: null,
      payload: { kind: "oauth_callback_pub", publicationId, code: "oauth-code-123", state },
    });
    expect((await slackPublications.get(publicationId))?.status).toBe("live");
    const callsAfterFirst = base.http.calls.length;

    // Second callback for the same (now-live) publication must not
    // re-attempt token exchange (Slack's code is one-shot and would 400).
    const secondResult = await provider.continueInstall({
      publicationId: null,
      payload: { kind: "oauth_callback_pub", publicationId, code: "oauth-code-123", state },
    });
    expect(secondResult.kind).toBe("complete");
    expect(base.http.calls.length).toBe(callsAfterFirst);
  });

  it("rejects a code-exchange request the vendor rejects", async () => {
    const { base, container } = buildSlackTestContainer();
    base.tenants.set("user_1", "tn_acme");
    const provider = new SlackProvider(container, {
      gatewayOrigin: "https://gw.example.com",
      botScopes: ["chat:write"],
      userScopes: ["search:read.public"],
      defaultCapabilities: ["message.write"],
      managedApp: {
        clientId: "MANAGED_CLIENT_ID",
        clientSecret: "MANAGED_CLIENT_SECRET",
        signingSecret: "MANAGED_SIGNING_SECRET",
      },
    });

    const startResult = await provider.startManagedInstall({
      userId: "user_1",
      agentId: "agent_1",
      environmentId: "env_1",
      mode: "full",
      persona: PERSONA,
      returnUrl: "https://console.example.com/integrations/slack",
    });
    const { url, publicationId } = startResult.data as { url: string; publicationId: string };
    const state = new URL(url).searchParams.get("state")!;

    base.http.respondWith({
      status: 200,
      headers: {},
      body: JSON.stringify({ ok: false, error: "invalid_code" }),
    });

    await expect(
      provider.continueInstall({
        publicationId: null,
        payload: { kind: "oauth_callback_pub", publicationId, code: "bad-code", state },
      }),
    ).rejects.toThrow(/invalid_code/);
  });
});
