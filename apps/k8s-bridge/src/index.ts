import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { BridgeBackend } from "./backend";
import { resolveBridgeBackendKind } from "./backend";
import { authMiddleware } from "./auth";
import { K8sManager } from "./k8s-manager";
import { OpenShellManager } from "./openshell-manager";
import { createRouter } from "./router";
import { SandboxMonitor } from "./sandbox-monitor";
import { SlackNotifier } from "./slack-notifier";

const port = Number(process.env.PORT ?? 8100);
const token = process.env.K8S_BRIDGE_TOKEN;

if (!token) {
  console.error("FATAL: K8S_BRIDGE_TOKEN environment variable is required");
  process.exit(1);
}

const notifyOn = (
  process.env.SLACK_NOTIFY_ON ??
  "box_created,box_destroyed,box_error,health_degraded,sandbox_crashed,sandbox_oom,sandbox_pending,cluster_low_capacity"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const notifier = process.env.SLACK_WEBHOOK_URL
  ? new SlackNotifier(process.env.SLACK_WEBHOOK_URL, notifyOn)
  : undefined;

const app = new Hono();

// Backend selection. An explicit BRIDGE_BACKEND (k8s | openshell) is
// trusted as-is; when unset the bridge auto-detects — an
// OPENSHELL_GATEWAY_ENDPOINT selects the OpenShell backend (the bridge
// holds the gRPC client the CF Worker can't run), otherwise Kubernetes.
const selection = resolveBridgeBackendKind(process.env);
console.log(`bridge backend: ${selection.kind} — ${selection.reason}`);
const manager: BridgeBackend =
  selection.kind === "openshell" ? new OpenShellManager() : new K8sManager();

// Background poller for sandbox-level events (OOM, crash loops, stuck
// pending, low cluster capacity) that aren't triggered by a bridge API
// call — only runs when Slack notifications are configured. Kubernetes-only:
// the OpenShell backend owns no cluster to poll.
if (notifier && manager instanceof K8sManager) {
  new SandboxMonitor(manager, notifier).start();
}

app.use("/api/v1/boxes*", authMiddleware(token, ["boxes:read", "boxes:write"]));
app.use("/api/v1/cluster*", authMiddleware(token, ["cluster:read"]));
app.use("/api/v1/sandboxes*", authMiddleware(token, ["sandboxes:read"]));
app.use("/api/v1/health", authMiddleware(token, []));
app.route("/", createRouter(manager, notifier));

// 404 catch-all
app.notFound((c) => {
  return c.json({ error: "not_found", message: `Route ${c.req.method} ${c.req.path} not found` }, 404);
});

// Global error handler
app.onError((err, c) => {
  console.error("Unhandled error:", err);
  return c.json({ error: "internal_error", message: err.message }, 500);
});

serve(
  { fetch: app.fetch, port },
  (info) => {
    console.log(`k8s-bridge listening on http://0.0.0.0:${info.port}`);
  },
);
