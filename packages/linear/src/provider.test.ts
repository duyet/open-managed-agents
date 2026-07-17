// Unit tests for LinearProvider.startManagedInstall — the "Add to Linear"
// one-click flow (mirrors SlackProvider.startManagedInstall). Skips the BYOA
// credentials step by staging this deployment's managed OAuth App
// credentials directly, and returns the Linear authorize URL immediately.

import { describe, expect, it } from "vitest";
import type { Persona } from "@duyet/oma-integrations-core";
import { LinearProvider } from "./provider";
import { buildFakeLinearContainer } from "./test-fakes";

const PERSONA: Persona = { name: "Coder", avatarUrl: null };

describe("LinearProvider.startManagedInstall", () => {
  it("throws a clear error when no managed App is configured", async () => {
    const container = buildFakeLinearContainer();
    const provider = new LinearProvider(container, {
      gatewayOrigin: "https://gw.example.com",
      scopes: ["read", "write"],
      defaultCapabilities: ["issue.read"],
      managedApp: null,
    });

    await expect(
      provider.startManagedInstall({
        userId: "user_1",
        agentId: "agent_1",
        environmentId: "env_1",
        mode: "full",
        persona: PERSONA,
        returnUrl: "https://console.example.com/integrations/linear",
      }),
    ).rejects.toThrow(/no managed OAuth App configured/i);
  });

  it("stages managed credentials and returns the Linear authorize URL directly", async () => {
    const container = buildFakeLinearContainer();
    const provider = new LinearProvider(container, {
      gatewayOrigin: "https://gw.example.com",
      scopes: ["read", "write", "app:assignable"],
      defaultCapabilities: ["issue.read"],
      managedApp: {
        clientId: "MANAGED_CLIENT_ID",
        clientSecret: "MANAGED_CLIENT_SECRET",
        webhookSecret: "MANAGED_WEBHOOK_SECRET",
      },
    });

    const result = await provider.startManagedInstall({
      userId: "user_1",
      agentId: "agent_1",
      environmentId: "env_1",
      mode: "full",
      persona: PERSONA,
      returnUrl: "https://console.example.com/integrations/linear",
    });

    expect(result.kind).toBe("step");
    expect(result.step).toBe("install_link");
    const data = result.data as {
      url: string;
      publicationId: string;
      callbackUrl: string;
      webhookUrl: string;
    };
    expect(data.publicationId).toBeTruthy();

    // Authorize URL carries the managed client id + configured scopes, no
    // user-pasted credentials involved.
    const url = new URL(data.url);
    expect(url.searchParams.get("client_id")).toBe("MANAGED_CLIENT_ID");
    expect(url.searchParams.get("state")).toBeTruthy();

    // Credentials were staged on the publication row and it's ready for
    // OAuth (not sitting at pending_setup waiting on submitCredentials).
    const credentials = await container.publications.getCredentials(data.publicationId);
    expect(credentials?.clientId).toBe("MANAGED_CLIENT_ID");
    expect(credentials?.clientSecret).toBe("MANAGED_CLIENT_SECRET");
    expect(credentials?.webhookSecret).toBe("MANAGED_WEBHOOK_SECRET");
    const pub = await container.publications.get(data.publicationId);
    expect(pub?.status).toBe("awaiting_install");
  });
});
