import { Hono } from "hono";
import type { Env } from "../../env";
import { buildProviders } from "../../providers";

// GitHub managed workspace connect — the "Connect" one-click flow that
// installs this deployment's managed GitHub App onto a user's org/account
// WITHOUT binding an agent first (no publication). Internal-secret gated:
// apps/main forwards the authenticated GET /v1/integrations/github/managed/
// connect here with x-internal-secret + the resolved userId.
//
//   POST /github/managed/connect  { userId, returnUrl } → { url }
//
// The install callback GitHub redirects to afterwards
// (`GET /github/managed/callback`) is served by the shared gateway package
// (buildIntegrationsGatewayRoutes) — see the CfInstallBridge workspace branch.

const app = new Hono<{ Bindings: Env }>();

function requireInternalSecret(env: Env, headerValue: string | undefined): boolean {
  return Boolean(
    env.INTEGRATIONS_INTERNAL_SECRET &&
      headerValue === env.INTEGRATIONS_INTERNAL_SECRET,
  );
}

interface ConnectBody {
  userId: string;
  returnUrl: string;
}

app.post("/connect", async (c) => {
  if (!requireInternalSecret(c.env, c.req.header("x-internal-secret"))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const body = await c.req.json<ConnectBody>();
  if (!body.userId || !body.returnUrl) {
    return c.json({ error: "userId, returnUrl required" }, 400);
  }

  const { github } = buildProviders(c.env);

  try {
    const result = await github.beginManagedWorkspaceInstall({
      userId: body.userId,
      returnUrl: body.returnUrl,
    });
    return c.json({ url: result.url });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json(
      {
        error: "managed_install_unavailable",
        details: msg,
        remediation: "Configure the managed GitHub App secrets on this deployment.",
      },
      503,
    );
  }
});

export default app;
