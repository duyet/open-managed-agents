// BridgeBackend — the surface the HTTP router (and health checks) drive,
// independent of which sandbox substrate serves it.
//
// The bridge historically fronted Kubernetes pods (`K8sManager`). It now
// also fronts NVIDIA OpenShell sandboxes (`OpenShellManager`), delegating
// the gRPC control plane the Cloudflare Worker cannot speak to a Node
// process here. Both back the exact same boxrun-shaped HTTP API in
// router.ts, so the router depends on this interface rather than a concrete
// manager. Cluster/discovery/metrics methods are Kubernetes-shaped; the
// OpenShell backend returns degraded (empty / "unknown") values for them
// since it owns no cluster of its own.

import type {
  ClusterCapacity,
  ClusterInfo,
  NodeInfo,
  PodMetrics,
  SandboxDetail,
  SandboxPodInfo,
} from "./k8s-manager";

/** The executor subset the router calls on a managed box. */
export interface BoxExecutor {
  exec(command: string, timeout?: number): Promise<string>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<string>;
  setEnvVars(envVars: Record<string, string>): Promise<void>;
  destroy(): Promise<void>;
}

export interface CreateBoxOptions {
  image?: string;
  cpu?: string;
  memory?: string;
}

export interface BridgeBackend {
  // Box lifecycle
  createBox(sessionId: string, options?: CreateBoxOptions): Promise<string>;
  getBox(boxId: string): { executor: BoxExecutor; sessionId: string } | undefined;
  destroyBox(boxId: string): Promise<void>;
  activeCount(): number;

  // Cluster / discovery (Kubernetes-shaped; degraded on OpenShell)
  getK8sVersion(): Promise<string>;
  getNodeCount(): Promise<number>;
  getClusterInfo(): Promise<ClusterInfo>;
  getNodes(): Promise<NodeInfo[]>;
  getClusterCapacity(): Promise<ClusterCapacity>;
  discoverSandboxes(): Promise<SandboxPodInfo[]>;
  getSandboxLogs(podName: string, tailLines?: number): Promise<string>;
  getPodMetrics(): Promise<PodMetrics[]>;
  getSandboxDetail(id: string): Promise<SandboxDetail | null>;
}
