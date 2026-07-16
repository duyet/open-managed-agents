import { describe, expect, it, vi } from "vitest";
import { K8sManager } from "../src/k8s-manager";

// The K8s client is loaded lazily via a private getCoreApi() helper. Tests
// stub that helper directly rather than mocking @kubernetes/client-node,
// keeping the fake surface small and matching only the two calls
// getSandboxDetail makes (readNamespacedPod, plus getPodMetrics's own
// dynamic import which we let fail closed to []).
function withFakeCoreApi(manager: K8sManager, coreApi: Record<string, unknown>): void {
  (manager as unknown as { getCoreApi: () => Promise<unknown> }).getCoreApi = vi.fn(async () => coreApi);
}

describe("K8sManager.getSandboxDetail", () => {
  it("returns full pod detail with null metrics when metrics-server is unavailable", async () => {
    const manager = new K8sManager("test-ns");
    const pod = {
      metadata: {
        name: "box-sess-123",
        namespace: "test-ns",
        labels: { "oma.dev/managed": "true", "oma.dev/session-id": "sess-123" },
        creationTimestamp: new Date(Date.now() - 5000).toISOString(),
      },
      spec: {
        nodeName: "node-a",
        containers: [{ name: "sandbox", resources: { requests: { cpu: "500m", memory: "512Mi" } } }],
      },
      status: {
        phase: "Running",
        containerStatuses: [
          { name: "sandbox", ready: true, restartCount: 2, state: { running: {} } },
        ],
      },
    };

    withFakeCoreApi(manager, {
      readNamespacedPod: vi.fn(async () => ({ body: pod })),
    });

    const detail = await manager.getSandboxDetail("box-sess-123");

    expect(detail).not.toBeNull();
    expect(detail?.podName).toBe("box-sess-123");
    expect(detail?.namespace).toBe("test-ns");
    expect(detail?.nodeName).toBe("node-a");
    expect(detail?.status).toBe("Running");
    expect(detail?.containerStatuses).toEqual([
      { name: "sandbox", ready: true, restartCount: 2, state: "running" },
    ]);
    expect(detail?.cpuRequest).toBe("500m");
    expect(detail?.memoryRequest).toBe("512Mi");
    expect(detail?.durationSeconds).toBeGreaterThanOrEqual(0);
    expect(detail?.metrics).toBeNull();
  });

  it("returns null when the pod doesn't exist", async () => {
    const manager = new K8sManager("test-ns");
    withFakeCoreApi(manager, {
      readNamespacedPod: vi.fn(async () => {
        throw new Error("404 Not Found");
      }),
    });

    const detail = await manager.getSandboxDetail("missing-pod");
    expect(detail).toBeNull();
  });

  it("does not expose raw pod manifest or secret-bearing fields", async () => {
    const manager = new K8sManager("test-ns");
    const pod = {
      metadata: {
        name: "box-sess-456",
        namespace: "test-ns",
        labels: { "oma.dev/managed": "true" },
        creationTimestamp: new Date().toISOString(),
      },
      spec: { nodeName: "node-b", containers: [], serviceAccountName: "leaked-sa" },
      status: { phase: "Running" },
    };

    withFakeCoreApi(manager, {
      readNamespacedPod: vi.fn(async () => ({ body: pod })),
    });

    const detail = await manager.getSandboxDetail("box-sess-456");

    expect(detail).not.toBeNull();
    expect(JSON.stringify(detail)).not.toContain("serviceAccountName");
    expect(JSON.stringify(detail)).not.toContain("leaked-sa");
  });
});
