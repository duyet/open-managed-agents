interface KubernetesSandboxOptions {
  sessionId: string;
  namespace?: string;
  image?: string;
  command?: string[];
  runtimeClassName?: string;
  serviceAccountName?: string;
  cpu?: string;
  memory?: string;
  readyTimeoutMs?: number;
  defaultTimeoutMs?: number;
  memoryBucket?: {
    endpoint: string;
    accessKey: string;
    secretKey: string;
    bucketName: string;
  };
  logger?: { warn: (msg: string, ctx?: unknown) => void; log: (msg: string) => void };
}

interface KubernetesSandboxExecutorLike {
  exec(command: string, timeout?: number): Promise<string>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<string>;
  setEnvVars(envVars: Record<string, string>): Promise<void>;
  destroy(): Promise<void>;
}

interface ManagedBox {
  executor: KubernetesSandboxExecutorLike;
  sessionId: string;
  createdAt: Date;
}

interface K8sClientModule {
  KubeConfig: new () => {
    loadFromCluster(): void;
    loadFromDefault(): void;
    makeApiClient<T>(ctor: new (...args: never[]) => T): T;
  };
  CoreV1Api: new (...args: never[]) => {
    getAPIVersions(): Promise<{ body?: { versions?: string[]; serverAddressByClientCIDRs?: unknown[] } } | unknown>;
    listNode(): Promise<{ body?: { items?: Array<{ metadata?: { name?: string } }> } } | { items?: Array<{ metadata?: { name?: string } }> }>;
  };
}

export class K8sManager {
  private boxes = new Map<string, ManagedBox>();
  private clientPromise: Promise<K8sClientModule["CoreV1Api"]> | null = null;

  async getK8sVersion(): Promise<string> {
    try {
      const coreApi = await this.getCoreApi();
      const res = await coreApi.getAPIVersions();
      const body = unwrapBody<{ versions?: string[] }>(res);
      return body?.versions?.join(", ") ?? "unknown";
    } catch {
      return "unknown";
    }
  }

  async getNodeCount(): Promise<number> {
    try {
      const coreApi = await this.getCoreApi();
      const res = await coreApi.listNode();
      const body = unwrapBody<{ items?: unknown[] }>(res);
      return body?.items?.length ?? 0;
    } catch {
      return 0;
    }
  }

  private async getCoreApi(): Promise<K8sClientModule["CoreV1Api"]> {
    if (!this.clientPromise) this.clientPromise = this.loadCoreApi();
    return this.clientPromise;
  }

  private async loadCoreApi(): Promise<K8sClientModule["CoreV1Api"]> {
    const mod = (await import(/* @vite-ignore */ "@kubernetes/client-node" as string)) as unknown as K8sClientModule;
    const kc = new mod.KubeConfig();
    if (process.env.KUBERNETES_SERVICE_HOST) {
      kc.loadFromCluster();
    } else {
      kc.loadFromDefault();
    }
    return kc.makeApiClient(mod.CoreV1Api);
  }

  async createBox(sessionId: string, options?: {
    image?: string;
    cpu?: string;
    memory?: string;
    runtimeClassName?: string;
    serviceAccountName?: string;
    namespace?: string;
    readyTimeoutMs?: number;
  }): Promise<string> {
    const boxId = "box-" + sessionId.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 60);

    const mod = await import("@duyet/oma-sandbox/adapters/kubernetes");
    const executor: KubernetesSandboxExecutorLike = new mod.KubernetesSandboxExecutor({
      sessionId,
      namespace: options?.namespace ?? process.env.OMA_K8S_NAMESPACE ?? "default",
      image: options?.image ?? process.env.SANDBOX_IMAGE ?? "node:22-slim",
      cpu: options?.cpu ?? process.env.OMA_K8S_CPU,
      memory: options?.memory ?? process.env.OMA_K8S_MEMORY,
      runtimeClassName: options?.runtimeClassName ?? process.env.OMA_K8S_RUNTIME_CLASS,
      serviceAccountName: options?.serviceAccountName ?? process.env.OMA_K8S_SERVICE_ACCOUNT,
      readyTimeoutMs: Number(options?.readyTimeoutMs ?? process.env.OMA_K8S_READY_TIMEOUT_MS ?? 120_000),
    } as KubernetesSandboxOptions);

    this.boxes.set(boxId, { executor, sessionId, createdAt: new Date() });
    return boxId;
  }

  getBox(boxId: string): { executor: KubernetesSandboxExecutorLike; sessionId: string } | undefined {
    const box = this.boxes.get(boxId);
    if (!box) return undefined;
    return { executor: box.executor, sessionId: box.sessionId };
  }

  async destroyBox(boxId: string): Promise<void> {
    const box = this.boxes.get(boxId);
    if (!box) return;
    try {
      await box.executor.destroy();
    } finally {
      this.boxes.delete(boxId);
    }
  }

  activeCount(): number {
    return this.boxes.size;
  }

  listBoxes(): Array<{ id: string; sessionId: string; createdAt: Date }> {
    return Array.from(this.boxes.entries()).map(([id, box]) => ({
      id,
      sessionId: box.sessionId,
      createdAt: box.createdAt,
    }));
  }
}

function unwrapBody<T>(res: { body?: unknown } | unknown): T {
  if (res && typeof res === "object" && "body" in res) return (res as { body: T }).body;
  return res as T;
}
