// Provider configuration — the BYOK (bring your own key) contract.
//
// Each SandboxProviderConfig holds everything needed to create sandbox
// executors: adapter type, API key (user-provided or system), endpoint URL,
// and provider-specific tunables. Multiple provider configs can coexist;
// environments select one by ID instead of the old single SANDBOX_PROVIDER.
//
// System providers are seeded from env vars at startup (e.g. DAYTONA_API_KEY
// → a provider config with isSystem=true). User providers are added via
// POST /v1/sandbox_providers and persisted.

import type { SandboxFactory, SandboxFactoryContext, SandboxExecutor } from "./ports";

/**
 * A single sandbox provider registration.
 */
export interface SandboxProviderConfig {
  /** Unique provider id — used in environment `config.sandbox_provider`. */
  id: string;
  /** Adapter type: "subprocess" | "litebox" | "boxrun" | "daytona" | "e2b" | "k8s" | "cloud". */
  type: string;
  /** Human-readable label (e.g. "My Daytona account"). */
  label: string;
  /** Optional longer description. */
  description?: string;
  /** User-provided API key (BYOK). Empty for system providers that read env vars directly. */
  apiKey?: string;
  /** Custom base URL for the provider's API. */
  baseURL?: string;
  /** Provider-specific settings (image, memory, cpu, namespace, etc.). */
  config?: Record<string, string>;
  /** When true, this config was seeded from env vars and cannot be deleted. */
  isSystem: boolean;
  /** Tenant scope — null for system-wide, set for tenant-scoped BYOK. */
  tenantId?: string;
  /** Timestamps. */
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Resolved provider — a config paired with its import factory.
 * The factory is loaded once and cached so subsequent sandbox creates
 * skip the dynamic import.
 */
export interface ResolvedSandboxProvider {
  config: SandboxProviderConfig;
  factory: SandboxFactory;
}

// ─── System provider key map ─────────────────────────────────────────
//
// Maps adapter type → { envKeys: string[], factoryPath: string }.
// Used to seed system providers from process.env at startup and to
// generate the hosting_types response.

export interface SystemProviderDescriptor {
  /** Adapter type string (matches adapter file name). */
  type: string;
  /** Human label. */
  label: string;
  /** Short description for hosting_types / docs. */
  description: string;
  /** Env vars this provider reads. First one found seeds the provider. */
  envKeys: string[];
  /** Dynamic import path for the factory. */
  factoryPath: string;
  /**
   * Whether this adapter is architecturally capable of running inside a
   * Cloudflare Worker: pure outbound HTTP/fetch calls, no Node-only
   * builtins (child_process, native FFI bindings, local kubeconfig/
   * filesystem access). `false` means the adapter cannot run in a Worker
   * at all, regardless of bundling — a session configured for it on the
   * Cloudflare deployment must fail clearly, not silently fall back.
   * See `classifyCfSandboxProvider` below and
   * apps/agent/src/runtime/sandbox.ts's `resolveCfSandbox`, which reads
   * this flag (not the registry's lazy `import(factoryPath)` — that path
   * uses a runtime-variable import target, which esbuild can't statically
   * bundle for a single-file Worker script, so it's Node-only in practice).
   */
  cfCompatible: boolean;
}

export const SYSTEM_PROVIDERS: SystemProviderDescriptor[] = [
  {
    type: "subprocess",
    label: "Local subprocess",
    description: "Node child_process on the host. Zero isolation — trusted local dev only.",
    envKeys: [],
    factoryPath: "@duyet/oma-sandbox/adapters/local-subprocess",
    cfCompatible: false,
  },
  {
    type: "litebox",
    label: "LiteBox (local micro-VM)",
    description: "Local Firecracker micro-VM per box. Hardware isolation, no daemon.",
    envKeys: ["LITEBOX_MEMORY_MIB"],
    factoryPath: "@duyet/oma-sandbox/adapters/litebox",
    cfCompatible: false,
  },
  {
    type: "boxrun",
    label: "BoxRun (remote micro-VM)",
    description: "Talks to a remote BoxLite HTTP control plane — hardware isolation without local KVM.",
    envKeys: ["BOXRUN_URL", "BOXRUN_TOKEN"],
    factoryPath: "@duyet/oma-sandbox/adapters/boxrun",
    cfCompatible: true,
  },
  {
    type: "daytona",
    label: "Daytona",
    description: "Daytona SaaS — a managed Linux VM per session. Requires DAYTONA_API_KEY.",
    envKeys: ["DAYTONA_API_KEY", "DAYTONA_API_URL"],
    factoryPath: "@duyet/oma-sandbox/adapters/daytona",
    cfCompatible: true,
  },
  {
    type: "e2b",
    label: "E2B",
    description: "E2B Firecracker microVM per session (~250ms cold from a warm pool). Requires E2B_API_KEY.",
    envKeys: ["E2B_API_KEY", "E2B_API_URL"],
    factoryPath: "@duyet/oma-sandbox/adapters/e2b",
    cfCompatible: true,
  },
  {
    type: "k8s",
    label: "Kubernetes",
    description: "Pod provisioned via the kubernetes-sigs agent-sandbox controller.",
    envKeys: ["OMA_K8S_NAMESPACE"],
    factoryPath: "@duyet/oma-sandbox/adapters/kubernetes",
    cfCompatible: false,
  },
  {
    type: "k8s-remote",
    label: "Kubernetes (remote gateway)",
    description: "Talks to an in-cluster k8s-sandbox-gateway over plain fetch — k8s pods without a Worker-side kubeconfig.",
    envKeys: ["K8S_SANDBOX_GATEWAY_URL", "K8S_SANDBOX_TOKEN"],
    factoryPath: "@duyet/oma-sandbox/adapters/kubernetes-remote",
    cfCompatible: true,
  },
  {
    type: "cloud",
    label: "Cloudflare Sandbox",
    description: "Managed sandbox — uses Cloudflare Containers.",
    envKeys: [],
    factoryPath: "", // CF path is direct, not via adapters
    cfCompatible: true,
  },
];

// ─── Cloudflare-side classification ──────────────────────────────────
//
// The registry's `createExecutor` (registry.ts) lazily resolves adapters
// via `import(desc.factoryPath)`, where `factoryPath` is read off a Map
// entry at runtime — a non-literal import target. esbuild can't statically
// bundle that for a single-file Worker script, and workerd has no runtime
// module resolution to fall back on, so the registry itself cannot be used
// from a Cloudflare Worker. `resolveCfSandbox` in
// apps/agent/src/runtime/sandbox.ts uses `classifyCfSandboxProvider`
// instead, then statically imports only the specific cfCompatible adapters
// it actually wires up.

export type CfSandboxResolution =
  | { kind: "cloudflare" }
  | { kind: "remote"; type: string }
  | { kind: "unavailable"; type: string };

/**
 * Classify a `sandbox_provider` id (or legacy `config.type`) for the
 * Cloudflare deployment. Pure / no I/O so it's unit-testable without any
 * Workers runtime.
 *
 *  - absent, `"cloud"`, or an id this registry doesn't recognize →
 *    `{ kind: "cloudflare" }` — degrade to the existing CloudflareSandbox
 *    default rather than hard-failing a misconfigured/unknown id (mirrors
 *    apps/main-node's `resolveEnvProvider` "unknown → fall back" behavior).
 *  - a known id with `cfCompatible: true` → `{ kind: "remote", type }`.
 *  - a known id with `cfCompatible: false` → `{ kind: "unavailable", type }`
 *    (subprocess / litebox / k8s — Node-only, cannot run in a Worker at all).
 */
export function classifyCfSandboxProvider(
  providerId: string | undefined | null,
): CfSandboxResolution {
  const id = (providerId ?? "").trim().toLowerCase();
  if (!id || id === "cloud") return { kind: "cloudflare" };
  const desc = SYSTEM_PROVIDERS.find((p) => p.type === id);
  if (!desc) return { kind: "cloudflare" };
  return desc.cfCompatible ? { kind: "remote", type: id } : { kind: "unavailable", type: id };
}

/**
 * Seed system provider configs from env vars. Returns an array of
 * SandboxProviderConfig, one per adapter type that can be reached
 * with the current env (or always for subprocess/litebox).
 */
export function seedSystemProviders(
  env: Record<string, string | undefined>,
): SandboxProviderConfig[] {
  const providers: SandboxProviderConfig[] = [];

  for (const desc of SYSTEM_PROVIDERS) {
    // subprocess and cloud are always available
    if (desc.type === "subprocess" || desc.type === "cloud") {
      providers.push({
        id: desc.type,
        type: desc.type,
        label: desc.label,
        description: desc.description,
        isSystem: true,
      });
      continue;
    }

    // Other providers need at least one env key to confirm they're reachable
    if (desc.envKeys.length > 0 && desc.envKeys.some((k) => env[k])) {
      providers.push({
        id: desc.type,
        type: desc.type,
        label: desc.label,
        description: desc.description,
        apiKey: desc.envKeys.length === 1 ? env[desc.envKeys[0]] : undefined,
        isSystem: true,
      });
    }
  }

  return providers;
}

/**
 * Build a flat env map from a provider config, suitable for passing to
 * the adapter factory. Merges the config's apiKey, baseURL, and extras
 * into a single record so factories (which read process.env-shaped maps)
 * work without changes.
 */
export function providerConfigToEnv(config: SandboxProviderConfig): Record<string, string> {
  const env: Record<string, string> = {};

  if (config.apiKey) {
    switch (config.type) {
      case "daytona":
        env.DAYTONA_API_KEY = config.apiKey;
        break;
      case "e2b":
        env.E2B_API_KEY = config.apiKey;
        break;
      case "boxrun":
        env.BOXRUN_TOKEN = config.apiKey;
        break;
    }
  }

  if (config.baseURL) {
    switch (config.type) {
      case "daytona":
        env.DAYTONA_API_URL = config.baseURL;
        break;
      case "e2b":
        env.E2B_API_URL = config.baseURL;
        break;
      case "boxrun":
        env.BOXRUN_URL = config.baseURL;
        break;
    }
  }

  // Provider-specific extras
  if (config.config) {
    for (const [k, v] of Object.entries(config.config)) {
      env[k.toUpperCase()] = v;
    }
  }

  return env;
}

/**
 * Check whether a set of env vars (from process.env-style record) is
 * sufficient for a given adapter type. Returns null if yes; an error
 * message if not.
 */
export function checkProviderRequirements(
  type: string,
  env: Record<string, string | undefined>,
): string | null {
  const desc = SYSTEM_PROVIDERS.find((p) => p.type === type);
  if (!desc) return `Unknown provider type: ${type}`;
  if (desc.envKeys.length === 0) return null; // no requirements

  const missing = desc.envKeys.filter((k) => !env[k]);
  if (missing.length > 0 && desc.type !== "litebox") {
    // litebox is optional — missing memory/cpu just means defaults
    return `Missing required env vars: ${missing.join(", ")}`;
  }

  return null;
}
