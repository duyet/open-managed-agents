/**
 * BridgeSandboxManager — executes relayed sandbox ops on the local machine.
 *
 * The Cloudflare deployment can't spawn `child_process` inside a Worker, so an
 * agent with a *local* environment (`sandbox_provider: "subprocess"`) has its
 * sandbox ops relayed here over the daemon WebSocket. This mirrors the
 * self-host `LocalSubprocessSandbox` (packages/sandbox) with a lean,
 * dependency-free implementation (node builtins only) so it doesn't bloat the
 * published CLI bundle.
 *
 * Protocol (see apps/agent/src/runtime/bridge-relay.ts + apps/main
 * runtime-room.ts):
 *
 *   in   { type: "sandbox.op", op, request_id, session_id, tenant_id?, ...args }
 *   out  { type: "sandbox.result", request_id, session_id, tenant_id?, ok, result?, error? }
 *
 * SECURITY: like LocalSubprocessSandbox, this has ZERO process isolation — it
 * runs on the user's host filesystem. That is the whole point of a "local"
 * environment: the user opted their own machine in via `oma bridge setup`.
 * Per-session workdirs live under <baseDir>/<sessionId>/.
 */

import { spawn } from "node:child_process";
import { promises as fs, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type SandboxSend = (msg: Record<string, unknown>) => void;

export interface SandboxOpRequest {
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

interface SessionBox {
  workdir: string;
  envVars: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export function defaultSandboxBaseDir(): string {
  // XDG-ish location under the user's home, isolated from bridge config state.
  return join(homedir(), ".local", "share", "oma", "sandboxes");
}

export class BridgeSandboxManager {
  #send: SandboxSend;
  #baseDir: string;
  #boxes = new Map<string, SessionBox>();

  constructor(send: SandboxSend, opts?: { baseDir?: string }) {
    this.#send = send;
    this.#baseDir = opts?.baseDir ? resolve(opts.baseDir) : defaultSandboxBaseDir();
  }

  /** Re-point the sender after a WS reconnect (mirrors SessionManager.setSender). */
  setSend(send: SandboxSend): void {
    this.#send = send;
  }

  /** Handle one relayed op frame: execute locally, then send the result. */
  async handle(req: SandboxOpRequest): Promise<void> {
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

  /** Best-effort teardown of every session workdir. Called on daemon stop. */
  destroyAll(): void {
    for (const box of this.#boxes.values()) {
      try {
        rmSync(box.workdir, { recursive: true, force: true });
      } catch { /* best-effort */ }
    }
    this.#boxes.clear();
  }

  // ── op dispatch ──────────────────────────────────────────────────────────

  async #exec(sessionId: string, req: SandboxOpRequest): Promise<Record<string, unknown>> {
    const box = this.#ensureBox(sessionId);
    switch (req.op) {
      case "exec": {
        const output = await this.#runCommand(box, req.command ?? "", req.timeout ?? DEFAULT_TIMEOUT_MS);
        return { output };
      }
      case "readFile": {
        const content = await fs.readFile(this.#resolvePath(box, req.path ?? ""), "utf8");
        return { content };
      }
      case "readFileBytes": {
        const buf = await fs.readFile(this.#resolvePath(box, req.path ?? ""));
        return { base64: buf.toString("base64") };
      }
      case "writeFile": {
        const full = this.#resolvePath(box, req.path ?? "");
        await fs.mkdir(dirname(full), { recursive: true });
        await fs.writeFile(full, req.content ?? "", "utf8");
        return {};
      }
      case "writeFileBytes": {
        const full = this.#resolvePath(box, req.path ?? "");
        await fs.mkdir(dirname(full), { recursive: true });
        await fs.writeFile(full, Buffer.from(req.base64 ?? "", "base64"));
        return {};
      }
      case "setEnvVars": {
        box.envVars = { ...box.envVars, ...(req.envVars ?? {}) };
        return {};
      }
      case "ping": {
        return {};
      }
      case "destroy": {
        this.#boxes.delete(sessionId);
        try {
          rmSync(box.workdir, { recursive: true, force: true });
        } catch { /* best-effort */ }
        return {};
      }
      default:
        throw new Error(`unknown sandbox op "${req.op}"`);
    }
  }

  #runCommand(box: SessionBox, command: string, timeoutMs: number): Promise<string> {
    return new Promise<string>((resolveExec) => {
      const child = spawn("/bin/sh", ["-c", command], {
        cwd: box.workdir,
        env: { ...(process.env as Record<string, string>), ...box.envVars, PWD: box.workdir },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (c: Buffer) => { stdout += c.toString("utf8"); });
      child.stderr?.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });

      const killer = setTimeout(() => {
        try {
          child.kill("SIGTERM");
          setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 1_000);
        } catch { /* gone */ }
      }, timeoutMs);

      child.on("close", (code, signal) => {
        clearTimeout(killer);
        const exit = signal ? `signal=${signal}` : `exit=${code}`;
        const combined =
          (stdout + (stderr ? `\n${stderr}` : "")).replace(/\s+$/, "") +
          (code !== 0 ? `\n[exit ${exit}]` : "");
        resolveExec(combined);
      });
      child.on("error", (err) => {
        clearTimeout(killer);
        resolveExec(`[error: ${err.message}]`);
      });
    });
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  #ensureBox(sessionId: string): SessionBox {
    let box = this.#boxes.get(sessionId);
    if (!box) {
      const workdir = join(this.#baseDir, sanitizeSessionId(sessionId));
      mkdirSync(workdir, { recursive: true });
      box = { workdir, envVars: {} };
      this.#boxes.set(sessionId, box);
    }
    return box;
  }

  /**
   * Resolve a sandbox-relative path into the session workdir. The harness emits
   * `/workspace/...` conventions; rewrite that to the workdir root so tools
   * land somewhere real. Absolute paths outside /workspace are the caller's
   * responsibility (mirrors LocalSubprocessSandbox).
   */
  #resolvePath(box: SessionBox, p: string): string {
    let normalised = p;
    if (normalised.startsWith("/workspace/")) normalised = normalised.slice("/workspace/".length);
    else if (normalised === "/workspace") normalised = "";
    else if (isAbsolute(normalised)) return normalised;
    return join(box.workdir, normalised);
  }

  #reply(req: SandboxOpRequest, payload: { ok: boolean; result?: Record<string, unknown>; error?: string }): void {
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

function sanitizeSessionId(sid: string): string {
  return sid.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128) || "session";
}
