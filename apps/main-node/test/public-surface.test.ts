// Public consumer surface on self-host Node (issue #226) — /v1/public/auth/*
// and /p/:slug/*, mirroring apps/main's CF coverage but hitting a real
// spawned main-node process (same pattern as dreams-route.test.ts).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface ProcessHandle {
  child: ChildProcess;
  port: number;
  dataDir: string;
  logBuf: string[];
}

const REPO_ROOT = resolve(__dirname, "../../..");
const MAIN_NODE_ENTRY = join(REPO_ROOT, "apps/main-node/src/index.ts");
const TSX_BIN = join(REPO_ROOT, "apps/main-node/node_modules/.bin/tsx");

describe("main-node public consumer surface", () => {
  let dataDir: string;
  let h: ProcessHandle | null = null;

  beforeEach(() => {
    dataDir = join(tmpdir(), `oma-test-public-${randomBytes(6).toString("hex")}`);
    mkdirSync(dataDir, { recursive: true });
  });

  afterEach(async () => {
    if (h) {
      await killHard(h).catch(() => {});
      h = null;
    }
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("mints a guest consumer session via POST /v1/public/auth/guest", async () => {
    h = await startMainNode({ dataDir });
    const base = `http://localhost:${h.port}`;

    const res = await fetch(`${base}/v1/public/auth/guest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      session_token: string;
      consumer_id: string;
      is_guest: boolean;
    };
    expect(body.session_token).toMatch(/^csess_/);
    expect(body.consumer_id).toMatch(/^cons_/);
    expect(body.is_guest).toBe(true);

    // GET /v1/public/auth/me resolves the same guest identity.
    const meRes = await fetch(`${base}/v1/public/auth/me`, {
      headers: { authorization: `Bearer ${body.session_token}` },
    });
    expect(meRes.status).toBe(200);
    const me = (await meRes.json()) as { id: string; is_guest: boolean };
    expect(me.id).toBe(body.consumer_id);
    expect(me.is_guest).toBe(true);
  });

  it("resolves a published agent by slug (metadata JSON + hosted HTML chat page)", async () => {
    h = await startMainNode({ dataDir });
    const base = `http://localhost:${h.port}`;

    const agentId = await createAgent(base);
    const slug = `node-pub-${randomBytes(4).toString("hex")}`;
    await publishAgent(base, agentId, slug);

    // API client (Accept: application/json) gets metadata.
    const jsonRes = await fetch(`${base}/p/${slug}`, {
      headers: { accept: "application/json" },
    });
    expect(jsonRes.status).toBe(200);
    const meta = (await jsonRes.json()) as { slug: string; requires_auth: boolean };
    expect(meta.slug).toBe(slug);
    expect(meta.requires_auth).toBe(false);

    // Browser (Accept: text/html) gets the self-contained hosted chat page.
    const htmlRes = await fetch(`${base}/p/${slug}`, {
      headers: { accept: "text/html" },
    });
    expect(htmlRes.status).toBe(200);
    expect(htmlRes.headers.get("content-type")).toContain("text/html");
    const html = await htmlRes.text();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain(slug);
  });

  it("hides an unpublished slug (404) and creates a real session for a free publication", async () => {
    h = await startMainNode({ dataDir });
    const base = `http://localhost:${h.port}`;

    const missing = await fetch(`${base}/p/does-not-exist`, {
      headers: { accept: "application/json" },
    });
    expect(missing.status).toBe(404);

    const agentId = await createAgent(base);
    const environmentId = await createEnvironment(base);
    const slug = `node-pub-free-${randomBytes(4).toString("hex")}`;
    await publishAgent(base, agentId, slug, environmentId);

    const guestRes = await fetch(`${base}/v1/public/auth/guest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const { session_token } = (await guestRes.json()) as { session_token: string };

    // Free publication with no environment configured on a local-runtime
    // agent should still create a session (local runtime doesn't need one).
    const sessRes = await fetch(`${base}/p/${slug}/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${session_token}`,
      },
      body: JSON.stringify({}),
    });
    expect(sessRes.status, await sessRes.text().catch(() => "")).toBe(201);
  });
}, 60_000);

async function createAgent(base: string): Promise<string> {
  const res = await fetch(`${base}/v1/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Public surface test agent",
      model: "claude-sonnet-4-6",
      system: "You are a test agent.",
      tools: [{ type: "agent_toolset_20260401" }],
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string };
  return body.id;
}

async function createEnvironment(base: string): Promise<string> {
  const res = await fetch(`${base}/v1/environments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `public-surface-test-${randomBytes(4).toString("hex")}` }),
  });
  if (res.status !== 201) {
    throw new Error(`environment create expected 201; got ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { id: string };
  return body.id;
}

async function publishAgent(
  base: string,
  agentId: string,
  slug: string,
  environmentId?: string,
): Promise<void> {
  const res = await fetch(`${base}/v1/agents/${agentId}/publications`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agent_id: agentId,
      slug,
      title: "Test bot",
      visibility: "public",
      status: "live",
      ...(environmentId ? { environment_id: environmentId } : {}),
    }),
  });
  if (res.status !== 201) {
    throw new Error(`publish expected 201; got ${res.status} ${await res.text()}`);
  }
}

async function startMainNode(opts: { dataDir: string }): Promise<ProcessHandle> {
  const port = await pickPort();
  const child = spawn(TSX_BIN, [MAIN_NODE_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_PATH: join(opts.dataDir, "oma.db"),
      AUTH_DATABASE_PATH: join(opts.dataDir, "auth.db"),
      SANDBOX_WORKDIR: join(opts.dataDir, "sandboxes"),
      MEMORY_BLOB_DIR: join(opts.dataDir, "memory-blobs"),
      FILES_BLOB_DIR: join(opts.dataDir, "files-blobs"),
      SESSION_OUTPUTS_DIR: join(opts.dataDir, "outputs"),
      AUTH_DISABLED: "1",
      BETTER_AUTH_SECRET: "test-secret-only-for-vitest",
      PLATFORM_ROOT_SECRET: "test-root-secret-only-for-vitest",
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logBuf: string[] = [];
  child.stdout?.on("data", (b: Buffer) => logBuf.push(b.toString()));
  child.stderr?.on("data", (b: Buffer) => logBuf.push(b.toString()));
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) {
        await sleep(300);
        return { child, port, dataDir: opts.dataDir, logBuf };
      }
    } catch {
      /* not ready */
    }
    await sleep(200);
  }
  console.error("main-node never became ready. Logs:\n" + logBuf.join(""));
  child.kill("SIGKILL");
  throw new Error(`main-node didn't respond on /health within 30s`);
}

function killHard(handle: ProcessHandle): Promise<void> {
  return new Promise((res) => {
    if (handle.child.exitCode !== null) return res();
    handle.child.once("exit", () => res());
    handle.child.kill("SIGKILL");
  });
}

function pickPort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const port = addr.port;
        srv.close(() => res(port));
      } else {
        rej(new Error("could not pick port"));
      }
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
