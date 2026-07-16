import { describe, expect, it, vi } from "vitest";
import { createRouter } from "../src/router";
import type { K8sManager, SandboxDetail } from "../src/k8s-manager";

function fakeManager(overrides: Partial<K8sManager> = {}): K8sManager {
  return overrides as K8sManager;
}

const sampleDetail: SandboxDetail = {
  id: "box-sess-123",
  boxId: "box-sess-123",
  sessionId: "sess-123",
  namespace: "default",
  podName: "box-sess-123",
  nodeName: "node-a",
  status: "Running",
  phase: "Running",
  containerStatuses: [{ name: "sandbox", ready: true, restartCount: 0, state: "running" }],
  cpuRequest: "500m",
  memoryRequest: "512Mi",
  createdAt: new Date().toISOString(),
  durationSeconds: 42,
  labels: {},
  metrics: {
    podName: "box-sess-123",
    namespace: "default",
    cpuUsage: "12m",
    memoryUsage: "64Mi",
    timestamp: new Date().toISOString(),
    containers: [{ name: "sandbox", cpuUsage: "12m", memoryUsage: "64Mi" }],
  },
};

describe("GET /api/v1/sandboxes/:id", () => {
  it("returns full sandbox detail on success", async () => {
    const getSandboxDetail = vi.fn().mockResolvedValue(sampleDetail);
    const router = createRouter(fakeManager({ getSandboxDetail }));

    const res = await router.request("/api/v1/sandboxes/box-sess-123");

    expect(res.status).toBe(200);
    expect(getSandboxDetail).toHaveBeenCalledWith("box-sess-123");
    const body = await res.json();
    expect(body).toEqual(sampleDetail);
  });

  it("returns 404 when the sandbox pod is not found", async () => {
    const getSandboxDetail = vi.fn().mockResolvedValue(null);
    const router = createRouter(fakeManager({ getSandboxDetail }));

    const res = await router.request("/api/v1/sandboxes/missing-pod");

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("not_found");
  });

  it("returns 500 when the manager throws", async () => {
    const getSandboxDetail = vi.fn().mockRejectedValue(new Error("k8s api unreachable"));
    const router = createRouter(fakeManager({ getSandboxDetail }));

    const res = await router.request("/api/v1/sandboxes/box-sess-123");

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("sandbox_detail_failed");
    expect(body.message).toBe("k8s api unreachable");
  });

  it("does not shadow the static /api/v1/sandboxes/metrics route", async () => {
    const getPodMetrics = vi.fn().mockResolvedValue([{ podName: "p1" }]);
    const getSandboxDetail = vi.fn();
    const router = createRouter(fakeManager({ getPodMetrics, getSandboxDetail }));

    const res = await router.request("/api/v1/sandboxes/metrics");

    expect(res.status).toBe(200);
    expect(getPodMetrics).toHaveBeenCalled();
    expect(getSandboxDetail).not.toHaveBeenCalled();
  });

  it("does not shadow the /api/v1/sandboxes/:podName/logs route", async () => {
    const getSandboxLogs = vi.fn().mockResolvedValue("log output");
    const getSandboxDetail = vi.fn();
    const router = createRouter(fakeManager({ getSandboxLogs, getSandboxDetail }));

    const res = await router.request("/api/v1/sandboxes/box-sess-123/logs");

    expect(res.status).toBe(200);
    expect(getSandboxLogs).toHaveBeenCalledWith("box-sess-123", undefined);
    expect(getSandboxDetail).not.toHaveBeenCalled();
  });
});
