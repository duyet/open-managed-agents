// Shared "fire a deployment" path — used by the manual run route
// (POST /v1/deployments/:id/run), the webhook endpoint
// (POST /v1/deployment_hooks/:hook_token), and the scheduled-deployment-runs
// cron launcher. All three converge here so a deployment run means the same
// thing however it's triggered.
//
// Resolves the deployment's tenant shard services and reuses the internal
// session-create path (createInternalSession), passing the deployment's
// environment, vaults, memory stores, pinned agent version, and initial
// message (as the opening user.message).

import type { Env } from "@duyet/oma-shared";
import { getCfServicesForTenant } from "@duyet/oma-services";
import { createInternalSession } from "../routes/internal";

/** The subset of a deployments row the run path needs. */
export interface DeploymentRunConfig {
  id: string;
  tenantId: string;
  agentId: string;
  agentVersion: number | null;
  environmentId: string | null;
  userId: string | null;
  vaultIds: string[];
  memoryStoreIds: string[];
  initialMessage: string;
}

/**
 * Create a session for a deployment and seed it with the opening message.
 * Returns the created session id. Throws on any failure (the cron tick
 * catches per-row; the routes surface it as a 4xx/5xx).
 *
 * `opts.message` overrides the deployment's stored initial_message (webhook
 * body override); when absent the stored initial_message is used.
 */
export async function launchDeploymentSession(
  env: Env,
  dep: DeploymentRunConfig,
  opts: { message?: string } = {},
): Promise<{ sessionId: string }> {
  if (!dep.environmentId) {
    throw new Error("deployment has no environment_id");
  }
  if (!dep.userId) {
    throw new Error("deployment has no user_id");
  }
  const message = opts.message ?? dep.initialMessage;
  const services = await getCfServicesForTenant(env, dep.tenantId);
  const result = await createInternalSession(env, services, {
    action: "create",
    userId: dep.userId,
    agentId: dep.agentId,
    environmentId: dep.environmentId,
    agentVersion: dep.agentVersion,
    vaultIds: dep.vaultIds,
    memoryStoreIds: dep.memoryStoreIds,
    metadata: { deployment_run: { deployment_id: dep.id } },
    initialEvent: {
      type: "user.message",
      content: [{ type: "text", text: message }],
    },
  });
  if (!result.ok) {
    throw new Error(`session create failed (${result.status}): ${result.error}`);
  }
  return { sessionId: result.sessionId };
}
