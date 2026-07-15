import { Hono } from "hono";
import { K8sManager } from "./k8s-manager";

export function createRouter(manager: K8sManager): Hono {
  const router = new Hono();

  // Health check
  router.get("/api/v1/health", async (c) => {
    const start = Date.now();
    const [k8sVersion, nodeCount] = await Promise.all([
      manager.getK8sVersion(),
      manager.getNodeCount(),
    ]);
    const latencyMs = Date.now() - start;

    return c.json({
      status: "ok",
      k8sVersion,
      nodeCount,
      activeBoxes: manager.activeCount(),
      latencyMs,
    });
  });

  // Create a box (sandbox pod)
  router.post("/api/v1/boxes", async (c) => {
    const body = await c.req.json<{
      sessionId?: string;
      image?: string;
      cpu?: string;
      memory?: string;
    }>();

    if (!body.sessionId) {
      return c.json({ error: "validation_error", message: "sessionId is required" }, 400);
    }

    try {
      const id = await manager.createBox(body.sessionId, {
        image: body.image,
        cpu: body.cpu,
        memory: body.memory,
      });
      return c.json({ id, status: "created" }, 201);
    } catch (err) {
      return c.json({ error: "create_failed", message: (err as Error).message }, 500);
    }
  });

  // Delete a box
  router.delete("/api/v1/boxes/:id", async (c) => {
    const { id } = c.req.param();
    const box = manager.getBox(id);
    if (!box) {
      return c.json({ error: "not_found", message: `Box ${id} not found` }, 404);
    }
    await manager.destroyBox(id);
    return c.body(null, 204);
  });

  // Exec command in a box
  router.post("/api/v1/boxes/:id/exec", async (c) => {
    const { id } = c.req.param();
    const box = manager.getBox(id);
    if (!box) {
      return c.json({ error: "not_found", message: `Box ${id} not found` }, 404);
    }

    const body = await c.req.json<{ command: string; timeoutMs?: number }>();
    if (!body.command) {
      return c.json({ error: "validation_error", message: "command is required" }, 400);
    }

    try {
      const result = await box.executor.exec(body.command, body.timeoutMs ?? 120_000);
      return c.json({ stdout: result, stderr: "", exitCode: 0 });
    } catch (err) {
      return c.json({ error: "exec_failed", message: (err as Error).message }, 500);
    }
  });

  // Read file from a box
  router.get("/api/v1/boxes/:id/files", async (c) => {
    const { id } = c.req.param();
    const box = manager.getBox(id);
    if (!box) {
      return c.json({ error: "not_found", message: `Box ${id} not found` }, 404);
    }

    const path = c.req.query("path");
    if (!path) {
      return c.json({ error: "validation_error", message: "path query parameter is required" }, 400);
    }

    try {
      const content = await box.executor.readFile(path);
      return c.text(content);
    } catch (err) {
      return c.json({ error: "read_failed", message: (err as Error).message }, 500);
    }
  });

  // Write file to a box
  router.put("/api/v1/boxes/:id/files", async (c) => {
    const { id } = c.req.param();
    const box = manager.getBox(id);
    if (!box) {
      return c.json({ error: "not_found", message: `Box ${id} not found` }, 404);
    }

    const path = c.req.query("path");
    if (!path) {
      return c.json({ error: "validation_error", message: "path query parameter is required" }, 400);
    }

    const body = await c.req.json<{ content: string }>();
    if (body.content === undefined) {
      return c.json({ error: "validation_error", message: "content is required" }, 400);
    }

    try {
      await box.executor.writeFile(path, body.content);
      return c.json({ status: "written", path });
    } catch (err) {
      return c.json({ error: "write_failed", message: (err as Error).message }, 500);
    }
  });

  // Set env vars for a box
  router.post("/api/v1/boxes/:id/env", async (c) => {
    const { id } = c.req.param();
    const box = manager.getBox(id);
    if (!box) {
      return c.json({ error: "not_found", message: `Box ${id} not found` }, 404);
    }

    const body = await c.req.json<{ envVars: Record<string, string> }>();
    if (!body.envVars || typeof body.envVars !== "object") {
      return c.json({ error: "validation_error", message: "envVars object is required" }, 400);
    }

    try {
      await box.executor.setEnvVars(body.envVars);
      return c.json({ status: "ok" });
    } catch (err) {
      return c.json({ error: "env_failed", message: (err as Error).message }, 500);
    }
  });

  // Get box status
  router.get("/api/v1/boxes/:id/status", async (c) => {
    const { id } = c.req.param();
    const box = manager.getBox(id);
    if (!box) {
      return c.json({ error: "not_found", message: `Box ${id} not found` }, 404);
    }

    return c.json({
      id,
      status: "running",
      conditions: [{ type: "Ready", status: "True" }],
    });
  });

  return router;
}
