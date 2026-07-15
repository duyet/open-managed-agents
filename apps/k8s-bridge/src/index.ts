import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { authMiddleware } from "./auth";
import { K8sManager } from "./k8s-manager";
import { createRouter } from "./router";

const port = Number(process.env.PORT ?? 8100);
const token = process.env.K8S_BRIDGE_TOKEN;

if (!token) {
  console.error("FATAL: K8S_BRIDGE_TOKEN environment variable is required");
  process.exit(1);
}

const app = new Hono();
const manager = new K8sManager();

app.use("/api/*", authMiddleware(token));
app.route("/", createRouter(manager));

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
