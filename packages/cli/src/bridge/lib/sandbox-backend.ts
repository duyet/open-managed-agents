/**
 * Sandbox-backend selection for the bridge daemon.
 *
 * By default an `oma bridge daemon` relays cloud-agent sandbox ops to the
 * *local* machine (`BridgeSandboxManager` — subprocess + host filesystem).
 * When pointed at an OpenShell gateway it instead relays each op to an
 * isolated OpenShell sandbox over gRPC (`OpenShellBridgeSandboxManager`),
 * reusing the `@duyet/oma-sandbox` adapter. This mirrors the k8s-bridge's
 * own `resolveBridgeBackendKind` (apps/k8s-bridge/src/backend.ts): an
 * explicit choice is trusted as-is; otherwise the presence of an OpenShell
 * endpoint auto-selects the OpenShell backend.
 *
 * The `SandboxRelayManager` interface is the surface the daemon drives,
 * independent of which substrate serves it — both managers implement it.
 */

export interface SandboxOpFrame {
  type?: string;
  op?: string;
  request_id?: string;
  session_id?: string;
  tenant_id?: string;
  command?: string;
  timeout?: number;
  path?: string;
  content?: string;
  base64?: string;
  envVars?: Record<string, string>;
}

export type SandboxSend = (msg: Record<string, unknown>) => void;

/** The substrate-agnostic surface the daemon holds a reference to. */
export interface SandboxRelayManager {
  handle(req: SandboxOpFrame): Promise<void>;
  setSend(send: SandboxSend): void;
  destroyAll(): void;
}

export type SandboxBackendKind = "local" | "openshell";

export interface OpenShellBackendConfig {
  /** gRPC endpoint `host:port` (e.g. `127.0.0.1:8080`). */
  endpoint: string;
  token?: string;
  image?: string;
}

export interface SandboxBackendSelection {
  kind: SandboxBackendKind;
  /** Human-readable reason, safe to log as-is. */
  reason: string;
  /** Present (and required non-empty) when `kind === "openshell"`. */
  openshell?: OpenShellBackendConfig;
}

export interface SandboxBackendFlags {
  /** `--backend <local|openshell>`. */
  backend?: string;
  /** `--openshell-url <host:port>`. */
  openshellUrl?: string;
}

/**
 * Resolve which sandbox backend the daemon should use. Pure — takes flags
 * and an env map so it's unit-testable without a process env.
 *
 * Precedence: an explicit `--backend` flag wins; then `OMA_BRIDGE_BACKEND`;
 * otherwise the presence of an OpenShell endpoint (flag or env) auto-selects
 * OpenShell, falling back to the local subprocess relay.
 *
 * The OpenShell endpoint is sourced from `--openshell-url`, then
 * `OMA_OPENSHELL_URL`, then `OPENSHELL_GATEWAY_ENDPOINT` (the same var the
 * `@duyet/oma-sandbox` adapter reads, so a bridge and a self-host deployment
 * are configured identically).
 */
export function resolveSandboxBackend(
  flags: SandboxBackendFlags,
  env: Record<string, string | undefined>,
): SandboxBackendSelection {
  const endpoint = (
    flags.openshellUrl ??
    env.OMA_OPENSHELL_URL ??
    env.OPENSHELL_GATEWAY_ENDPOINT ??
    ""
  ).trim();

  const openshell = (): OpenShellBackendConfig => ({
    endpoint,
    token: env.OMA_OPENSHELL_TOKEN ?? env.OPENSHELL_TOKEN,
    image: env.OMA_OPENSHELL_IMAGE ?? env.OPENSHELL_IMAGE,
  });

  const explicit = (flags.backend ?? env.OMA_BRIDGE_BACKEND ?? "").trim().toLowerCase();
  const explicitSource = flags.backend ? "--backend" : "OMA_BRIDGE_BACKEND";

  if (explicit === "openshell") {
    return {
      kind: "openshell",
      reason: `${explicitSource}=openshell (explicit)`,
      openshell: openshell(),
    };
  }
  if (explicit === "local" || explicit === "subprocess") {
    return { kind: "local", reason: `${explicitSource}=${explicit} (explicit)` };
  }
  if (explicit) {
    // An unrecognised explicit value is a user error — fail toward the safe
    // default (local) but say why, rather than silently ignoring it.
    return {
      kind: "local",
      reason: `${explicitSource}=${explicit} unrecognised — defaulting to local`,
    };
  }

  if (endpoint) {
    return {
      kind: "openshell",
      reason: `auto-detected: OpenShell endpoint ${endpoint}`,
      openshell: openshell(),
    };
  }
  return { kind: "local", reason: "auto-detected: no OpenShell gateway configured" };
}
