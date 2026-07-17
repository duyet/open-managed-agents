// At-rest encryption of vault credentials on the self-host Node runtime
// (issue #187).
//
// Before the fix, apps/main-node constructed the credential service without
// a crypto instance, so SqlCredentialRepo's identity fallback stored
// `auth` as plaintext JSON in ./data/oma.db — contradicting the documented
// PLATFORM_ROOT_SECRET guarantee (which the CF deployment enforces).
//
// These tests boot the real entry point (same tsx-subprocess pattern as
// promote-sandbox-file.test.ts), create a credential over HTTP, then read
// the sqlite file directly to prove the stored blob is ciphertext — and
// that a legacy plaintext row (written by a pre-fix install) still reads
// back fine (lazy-migration tolerance).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";

const REPO_ROOT = resolve(__dirname, "../../..");
const MAIN_NODE_ENTRY = join(REPO_ROOT, "apps/main-node/src/index.ts");
const TSX_BIN = join(REPO_ROOT, "apps/main-node/node_modules/.bin/tsx");

const SECRET_TOKEN = "ghp_super_secret_token_1234567890abcdef";

interface ProcessHandle {
  child: ChildProcess;
  port: number;
  dataDir: string;
  logBuf: string[];
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
  throw new Error("main-node didn't respond on /health within 30s");
}

function killHard(handle: ProcessHandle): Promise<void> {
  return new Promise((res) => {
    if (handle.child.exitCode !== null) return res();
    handle.child.once("exit", () => res());
    handle.child.kill("SIGKILL");
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
      } else rej(new Error("could not pick port"));
    });
  });
}

describe("vault credential at-rest encryption (issue #187)", () => {
  let dataDir: string;
  let h: ProcessHandle | null = null;

  beforeEach(() => {
    dataDir = join(tmpdir(), `oma-test-credcrypt-${randomBytes(6).toString("hex")}`);
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

  it("stores auth as ciphertext on disk, round-trips reads, and tolerates legacy plaintext rows", async () => {
    h = await startMainNode({ dataDir });
    const base = `http://localhost:${h.port}/v1`;

    // 1. Vault + credential over the real HTTP surface.
    const vRes = await fetch(`${base}/vaults`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "prod-secrets" }),
    });
    expect(vRes.status).toBe(201);
    const vault = (await vRes.json()) as { id: string };

    const cRes = await fetch(`${base}/vaults/${vault.id}/credentials`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        display_name: "GitHub Token",
        auth: {
          type: "static_bearer",
          mcp_server_url: "https://api.github.com",
          token: SECRET_TOKEN,
        },
      }),
    });
    expect(cRes.status).toBe(201);
    const cred = (await cRes.json()) as { id: string };

    // 2. Inspect the sqlite file directly — the validation the issue calls
    //    for: the stored value must NOT be the plaintext JSON of the token.
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const db = new BetterSqlite3(join(dataDir, "oma.db"), { readonly: false });
    try {
      const row = db
        .prepare("SELECT tenant_id, vault_id, auth FROM credentials WHERE id = ?")
        .get(cred.id) as { tenant_id: string; vault_id: string; auth: string };
      expect(row).toBeTruthy();
      expect(row.auth).not.toContain(SECRET_TOKEN);
      expect(row.auth.startsWith("{")).toBe(false);
      expect(() => JSON.parse(row.auth)).toThrow();

      // 3. The API still reads it back (decrypt path works); secrets stay
      //    stripped from the response.
      const listRes = await fetch(`${base}/vaults/${vault.id}/credentials`);
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as {
        data: Array<{ id: string; auth: { type: string; token?: string } }>;
      };
      const fromApi = list.data.find((c) => c.id === cred.id);
      expect(fromApi).toBeTruthy();
      expect(fromApi!.auth.type).toBe("static_bearer");
      expect(fromApi!.auth.token).toBeUndefined();

      // 4. Legacy tolerance: a pre-fix install wrote plaintext JSON. Insert
      //    one directly and confirm reads don't brick the whole vault.
      const legacyAuth = JSON.stringify({
        type: "static_bearer",
        mcp_server_url: "https://legacy.example.com",
        token: "legacy-plaintext-token",
      });
      db.prepare(
        "INSERT INTO credentials (id, tenant_id, vault_id, display_name, auth_type, mcp_server_url, provider, auth, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)",
      ).run(
        "cred_legacy_plaintext",
        row.tenant_id,
        row.vault_id,
        "Legacy Token",
        "static_bearer",
        "https://legacy.example.com",
        legacyAuth,
        Date.now(),
      );
    } finally {
      db.close();
    }

    const listRes2 = await fetch(`${base}/vaults/${vault.id}/credentials`);
    expect(listRes2.status).toBe(200);
    const list2 = (await listRes2.json()) as {
      data: Array<{ id: string; auth: { type: string } }>;
    };
    const legacy = list2.data.find((c) => c.id === "cred_legacy_plaintext");
    expect(legacy).toBeTruthy();
    expect(legacy!.auth.type).toBe("static_bearer");
  }, 120_000);
});
