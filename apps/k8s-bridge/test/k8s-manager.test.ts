// Unit tests for K8sManager cluster info/capacity/nodes endpoints, with
// `@kubernetes/client-node` fully mocked — no real cluster involved.
// Mirrors the mocking style used in packages/sandbox/test/kubernetes.test.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";

interface FakeNode {
  metadata: { name: string; labels?: Record<string, string> };
  spec?: { taints?: Array<{ key: string; value?: string; effect: string }> };
  status: {
    capacity: Record<string, string>;
    allocatable: Record<string, string>;
    conditions: Array<{ type: string; status: string }>;
    nodeInfo?: { architecture?: string; osImage?: string; kernelVersion?: string };
  };
}

interface FakePod {
  status?: { phase?: string };
  spec?: { containers?: Array<{ resources?: { requests?: { cpu?: string; memory?: string } } }> };
}

const world = {
  nodes: [] as FakeNode[],
  pods: [] as FakePod[],
  apiVersions: ["v1"] as string[],
};

vi.mock("@kubernetes/client-node", () => {
  class KubeConfig {
    loadFromCluster(): void {}
    loadFromDefault(): void {}
    makeApiClient<T>(Ctor: new () => T): T {
      return new Ctor();
    }
  }

  class CoreV1Api {
    async getAPIVersions() {
      return { body: { versions: world.apiVersions } };
    }
    async listNode() {
      return { body: { items: world.nodes } };
    }
    async listPodForAllNamespaces() {
      return { body: { items: world.pods } };
    }
    async listNamespacedPod() {
      return { body: { items: world.pods } };
    }
  }

  class Metrics {
    async getPodMetrics() {
      return { items: [] };
    }
  }

  return { KubeConfig, CoreV1Api, Metrics };
});

function makeNode(overrides: Partial<FakeNode["status"]> = {}, name = "node-1"): FakeNode {
  return {
    metadata: { name, labels: {} },
    spec: { taints: [] },
    status: {
      capacity: { cpu: "4", memory: "16Gi", pods: "110" },
      allocatable: { cpu: "3800m", memory: "15Gi", pods: "110" },
      conditions: [{ type: "Ready", status: "True" }],
      nodeInfo: { architecture: "amd64", osImage: "Linux", kernelVersion: "6.0" },
      ...overrides,
    },
  };
}

describe("K8sManager cluster endpoints", () => {
  beforeEach(() => {
    world.nodes = [];
    world.pods = [];
    world.apiVersions = ["v1"];
    delete process.env.OMA_K8S_CPU;
    delete process.env.OMA_K8S_MEMORY;
    vi.resetModules();
  });

  it("aggregates node capacity + version for getClusterInfo", async () => {
    const { K8sManager } = await import("../src/k8s-manager");
    world.nodes = [makeNode(), makeNode({}, "node-2")];

    const manager = new K8sManager("default");
    const info = await manager.getClusterInfo();

    expect(info.nodeCount).toBe(2);
    expect(info.k8sVersion).toBe("v1");
    expect(info.totalCpu).toBe("8.00"); // 2 nodes * 4 cpu
    expect(info.allocatableCpu).toBe("7.60"); // 2 * 3800m
    expect(info.maxPods).toBe(220);
  });

  it("maps per-node status, capacity, and taints for getNodes", async () => {
    const { K8sManager } = await import("../src/k8s-manager");
    world.nodes = [
      makeNode(),
      makeNode(
        { conditions: [{ type: "Ready", status: "False" }] },
        "node-not-ready",
      ),
    ];
    world.nodes[1].spec = { taints: [{ key: "dedicated", value: "gpu", effect: "NoSchedule" }] };

    const manager = new K8sManager("default");
    const nodes = await manager.getNodes();

    expect(nodes).toHaveLength(2);
    expect(nodes[0].status).toBe("Ready");
    expect(nodes[0].cpuCapacity).toBe("4");
    expect(nodes[1].status).toBe("NotReady");
    expect(nodes[1].taints).toEqual([{ key: "dedicated", value: "gpu", effect: "NoSchedule" }]);
  });

  it("computes allocatable vs requested capacity and sandbox headroom", async () => {
    const { K8sManager } = await import("../src/k8s-manager");
    process.env.OMA_K8S_CPU = "500m";
    process.env.OMA_K8S_MEMORY = "512Mi";

    // One node: 4 CPU / 16Gi capacity, 3800m / 15Gi allocatable, 110 max pods.
    world.nodes = [makeNode()];
    // Two running pods each requesting 500m CPU / 512Mi memory.
    world.pods = [
      { status: { phase: "Running" }, spec: { containers: [{ resources: { requests: { cpu: "500m", memory: "512Mi" } } }] } },
      { status: { phase: "Running" }, spec: { containers: [{ resources: { requests: { cpu: "500m", memory: "512Mi" } } }] } },
      { status: { phase: "Pending" }, spec: { containers: [{ resources: { requests: { cpu: "500m", memory: "512Mi" } } }] } },
    ];

    const manager = new K8sManager("default");
    const capacity = await manager.getClusterCapacity();

    expect(capacity.allocatableCpu).toBe("3.80");
    expect(capacity.allocatableMemory).toBe("15.00");
    expect(capacity.runningPods).toBe(2);
    expect(capacity.maxPods).toBe(110);
    // requested = 3 pods * 500m = 1500m; remaining = 3800m - 1500m = 2300m -> floor(2300/500) = 4
    // memory: requested = 3 * 512Mi = 1536Mi; allocatable 15Gi = 15360Mi; remaining = 13824Mi -> floor(/512) = 27
    // pod slots remaining = 110 - 2 = 108
    // estimate = min(4, 27, 108) = 4
    expect(capacity.estimatedAdditionalSandboxes).toBe(4);
  });

  it("returns zero headroom when the cluster is saturated", async () => {
    const { K8sManager } = await import("../src/k8s-manager");
    world.nodes = [makeNode({ capacity: { cpu: "1", memory: "1Gi", pods: "2" }, allocatable: { cpu: "1", memory: "1Gi", pods: "2" } })];
    world.pods = [
      { status: { phase: "Running" }, spec: { containers: [{ resources: { requests: { cpu: "1", memory: "1Gi" } } }] } },
      { status: { phase: "Running" }, spec: { containers: [] } },
    ];

    const manager = new K8sManager("default");
    const capacity = await manager.getClusterCapacity();

    expect(capacity.estimatedAdditionalSandboxes).toBe(0);
  });
});
