/**
 * OpenShellBridgeSandboxManager — relays cloud-agent sandbox ops to an
 * NVIDIA OpenShell gateway instead of the local machine.
 *
 * The sibling of `BridgeSandboxManager` (bridge-sandbox.ts): same relay
 * protocol and reply frames, same substrate-agnostic `SandboxRelayManager`
 * surface, but each session is backed by an isolated OpenShell sandbox
 * (policy-enforced egress, gRPC control plane) rather than a host subprocess.
 *
 * It reuses the `OpenShellSandbox` gRPC adapter from `@duyet/oma-sandbox`
 * exactly as the k8s-bridge's `OpenShellManager` does — via a dynamic import
 * so the lean CLI bundle only pulls the heavy gRPC deps when this backend is
 * actually selected (`--backend openshell` / `OMA_OPENSHELL_URL`). The
 * `@duyet/oma-sandbox` package is marked external in the CLI's esbuild bundle,
 * so it resolves from node_modules at runtime (present in the in-cluster
 * daemon Deployment).
 *
 * Protocol (see bridge-sandbox.ts + apps/agent/src/runtime/bridge-relay.ts):
 *   in   { type: "sandbox.op", op, request_id, session_id, tenant_id?, ...args }
 *   out  { type: "sandbox.result", request_id, session_id, tenant_id?, ok, result?, error? }
 *
 * Unlike the local relay, OpenShell owns its own workspace persistence and
 * outbound-credential injection (via policy + provider bundles), so there is
 * no host filesystem exposed and memory-store / session-outputs mounts are
 * not available — the same limitation the direct adapter documents.
 */

import type {
  OpenShellBackendConfig,
  SandboxOpFrame,
  SandboxRelayManager,
  SandboxSend,
} from "./sandbox-backend.js";

/** Structural view of the `OpenShellSandbox` executor we drive. */
interface OpenShellExecutor {
  exec(command: string, timeout?: number): Promise<string>;
  readFile(path: string): Promise<string>;
  readFileBytes(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string): Promise<string>;
  writeFileBytes(path: string, bytes: Uint8Array): Promise<string>;
  setEnvVars(envVars: Record<string, string>): Promise<void>;
  destroy(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export class OpenShellBridgeSandboxManager implements SandboxRelayManager {
  #send: SandboxSend;
  #config: OpenShellBackendConfig;
  #env: NodeJS.ProcessEnv;
  #boxes = new Map<string, OpenShellExecutor>();

  constructor(
    send: SandboxSend,
    config: OpenShellBackendConfig,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.#send = send;
    this.#config = config;
    this.#env = env;
  }

  /** Re-point the sender after a WS reconnect (mirrors BridgeSandboxManager). */
  setSend(send: SandboxSend): void {
    this.#send = send;
  }

  async handle(req: SandboxOpFrame): Promise<void> {
    const requestId = req.request_id;
    const sessionId = req.session_id;
    if (!requestId || !sessionId) return; // malformed — nothing to correlate
    try {
      const result = await this.#exec(sessionId, req);
      this.#reply(req, { ok: true, result });
    } catch (err) {
      this.#reply(req, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Best-effort teardown of every OpenShell sandbox. Called on daemon stop. */
  destroyAll(): void {
    for (const [sessionId, box] of this.#boxes) {
      void box.destroy().catch(() => { /* best-effort */ });
      this.#boxes.delete(sessionId);
    }
  }

  // ── op dispatch ──────────────────────────────────────────────────────────

  async #exec(sessionId: string, req: SandboxOpFrame): Promise<Record<string, unknown>> {
    // destroy on an unknown session is a no-op; every other op provisions
    // the sandbox lazily on first use (same as a fresh cloud session).
    if (req.op === "destroy") {
      const box = this.#boxes.get(sessionId);
      this.#boxes.delete(sessionId);
      if (box) await box.destroy();
      return {};
    }
    if (req.op === "ping") return {};

    const box = await this.#ensureBox(sessionId);
    switch (req.op) {
      case "exec": {
        const output = await box.exec(req.command ?? "", req.timeout ?? DEFAULT_TIMEOUT_MS);
        return { output };
      }
      case "readFile": {
        const content = await box.readFile(req.path ?? "");
        return { content };
      }
      case "readFileBytes": {
        const bytes = await box.readFileBytes(req.path ?? "");
        return { base64: Buffer.from(bytes).toString("base64") };
      }
      case "writeFile": {
        await box.writeFile(req.path ?? "", req.content ?? "");
        return {};
      }
      case "writeFileBytes": {
        await box.writeFileBytes(req.path ?? "", Buffer.from(req.base64 ?? "", "base64"));
        return {};
      }
      case "setEnvVars": {
        await box.setEnvVars(req.envVars ?? {});
        return {};
      }
      default:
        throw new Error(`unknown sandbox op "${req.op}"`);
    }
  }

  async #ensureBox(sessionId: string): Promise<OpenShellExecutor> {
    let box = this.#boxes.get(sessionId);
    if (box) return box;
    if (!this.#config.endpoint) {
      throw new Error(
        "OpenShell backend requires an endpoint — set --openshell-url or OMA_OPENSHELL_URL (e.g. 127.0.0.1:8080)",
      );
    }
    // Dynamic, externalised import: keeps the heavy gRPC deps out of the lean
    // CLI bundle. Mirrors apps/k8s-bridge/src/openshell-manager.ts.
    const mod = await import("@duyet/oma-sandbox/adapters/openshell" as string);
    box = new mod.OpenShellSandbox({
      endpoint: this.#config.endpoint,
      token: this.#config.token,
      image: this.#config.image,
      tls: mod.resolveOpenShellTlsFromEnv(this.#env),
      sessionId,
    }) as OpenShellExecutor;
    this.#boxes.set(sessionId, box);
    return box;
  }

  #reply(
    req: SandboxOpFrame,
    payload: { ok: boolean; result?: Record<string, unknown>; error?: string },
  ): void {
    const msg: Record<string, unknown> = {
      type: "sandbox.result",
      request_id: req.request_id,
      session_id: req.session_id,
      ok: payload.ok,
    };
    if (req.tenant_id) msg.tenant_id = req.tenant_id;
    if (payload.result !== undefined) msg.result = payload.result;
    if (payload.error !== undefined) msg.error = payload.error;
    try {
      this.#send(msg);
    } catch { /* socket died; relay op will time out */ }
  }
}
