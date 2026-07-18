// @ts-nocheck
// Route tests for /v1/skills — ported from apps/main/src/routes/skills.ts.
// Drives the Hono app against an in-memory KvStore + BlobStore via the
// shared `services` RouteServicesArg, matching the fake-store pattern used
// by mcp-servers.test.ts / model-cards.test.ts.

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { zipSync } from "fflate";
import { buildSkillRoutes } from "./index";
import { InMemoryKvStore } from "@duyet/oma-kv-store/adapters/in-memory";
import { InMemoryBlobStore } from "@duyet/oma-blob-store/adapters/in-memory";
import type { QuotaResult, QuotaService } from "@duyet/oma-quotas";
import type { RouteServices } from "../types";

const TENANT = "tn_test";

function makeApp(opts: {
  kv?: InMemoryKvStore;
  filesBlob?: InMemoryBlobStore | null;
  quota?: QuotaService;
}) {
  const kv = opts.kv ?? new InMemoryKvStore();
  const filesBlob = opts.filesBlob === undefined ? new InMemoryBlobStore() : opts.filesBlob;
  const app = new Hono<{ Variables: { tenant_id: string } }>();
  app.use("*", async (c, next) => {
    c.set("tenant_id", TENANT);
    await next();
  });
  const routes = buildSkillRoutes({
    services: { kv, filesBlob } as unknown as RouteServices,
    quota: opts.quota,
  });
  app.route("/", routes);
  return { app, kv, filesBlob };
}

const SKILL_MD = "---\nname: my-skill\ndescription: does things\n---\n\nBody text.";

describe("skills routes — JSON create/list/get/delete", () => {
  let app: Hono;

  beforeEach(() => {
    ({ app } = makeApp({}));
  });

  it("lists only builtins when the tenant has no custom skills", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.has_more).toBe(false);
    expect(json.next_page).toBeNull();
    expect(json.data.length).toBe(4);
    expect(json.data.every((s: { source: string }) => s.source === "anthropic")).toBe(true);
  });

  it("creates a custom skill from JSON files, deriving name from frontmatter", async () => {
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: [{ filename: "SKILL.md", content: SKILL_MD }] }),
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.type).toBe("skill");
    expect(json.name).toBe("my-skill");
    expect(json.description).toBe("does things");
    expect(json.source).toBe("custom");
    expect(json.files).toHaveLength(1);
    expect(json.files[0].content).toBe(SKILL_MD);
  });

  it("rejects an empty files array (400)", async () => {
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a name that fails NAME_RE (400)", async () => {
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        files: [{ filename: "SKILL.md", content: "---\nname: Bad Name!\n---\nx" }],
      }),
    });
    expect(res.status).toBe(400);
  });

  it("round-trips create -> list -> get -> delete", async () => {
    const created = await (
      await app.request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ files: [{ filename: "SKILL.md", content: SKILL_MD }] }),
      })
    ).json();

    const listed = await (await app.request("/")).json();
    expect(listed.data.some((s: { id: string }) => s.id === created.id)).toBe(true);

    const got = await app.request(`/${created.id}`);
    expect(got.status).toBe(200);
    const gotJson = await got.json();
    expect(gotJson.id).toBe(created.id);

    const del = await app.request(`/${created.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);

    const gone = await app.request(`/${created.id}`);
    expect(gone.status).toBe(404);
  });

  it("gets a builtin skill by id", async () => {
    const res = await app.request("/builtin_pdf");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.source).toBe("anthropic");
  });

  it("refuses to delete a builtin skill (403)", async () => {
    const res = await app.request("/builtin_pdf", { method: "DELETE" });
    expect(res.status).toBe(403);
  });

  it("404s get/delete on an unknown skill", async () => {
    expect((await app.request("/skill_missing")).status).toBe(404);
    expect((await app.request("/skill_missing", { method: "DELETE" })).status).toBe(404);
  });

  it("filters list by source=custom / source=anthropic", async () => {
    await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: [{ filename: "SKILL.md", content: SKILL_MD }] }),
    });
    const customOnly = await (await app.request("/?source=custom")).json();
    expect(customOnly.data).toHaveLength(1);
    expect(customOnly.data[0].source).toBe("custom");

    const builtinOnly = await (await app.request("/?source=anthropic")).json();
    expect(builtinOnly.data).toHaveLength(4);
  });

  it("rejects an unknown source filter (400)", async () => {
    const res = await app.request("/?source=nope");
    expect(res.status).toBe(400);
  });

  it("500s create when filesBlob is not configured", async () => {
    const { app: noBlobApp } = makeApp({ filesBlob: null });
    const res = await noBlobApp.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: [{ filename: "SKILL.md", content: SKILL_MD }] }),
    });
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe("FILES_BUCKET binding not configured");
  });
});

describe("skills routes — versions", () => {
  let app: Hono;
  let skillId: string;

  beforeEach(async () => {
    ({ app } = makeApp({}));
    const created = await (
      await app.request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ files: [{ filename: "SKILL.md", content: SKILL_MD }] }),
      })
    ).json();
    skillId = created.id;
  });

  it("creates a new version and lists it newest-first", async () => {
    await new Promise((r) => setTimeout(r, 2));
    const v2 = await app.request(`/${skillId}/versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        files: [{ filename: "SKILL.md", content: SKILL_MD }, { filename: "extra.txt", content: "hi" }],
      }),
    });
    expect(v2.status).toBe(201);

    const list = await (await app.request(`/${skillId}/versions`)).json();
    expect(list.data).toHaveLength(2);
    // Newest version first.
    expect(list.data[0].file_count).toBe(2);
    expect(list.data[1].file_count).toBe(1);
  });

  it("gets a specific version with file contents", async () => {
    const created = await (await app.request(`/${skillId}`)).json();
    const res = await app.request(`/${skillId}/versions/${created.latest_version}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.files[0].content).toBe(SKILL_MD);
  });

  it("refuses to delete the only version (400)", async () => {
    const created = await (await app.request(`/${skillId}`)).json();
    const res = await app.request(`/${skillId}/versions/${created.latest_version}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(400);
  });

  it("deletes a non-latest version, keeping the skill's latest_version pointer intact", async () => {
    const before = await (await app.request(`/${skillId}`)).json();
    await new Promise((r) => setTimeout(r, 2));
    await app.request(`/${skillId}/versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: [{ filename: "SKILL.md", content: SKILL_MD }] }),
    });

    const del = await app.request(`/${skillId}/versions/${before.latest_version}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);

    const list = await (await app.request(`/${skillId}/versions`)).json();
    expect(list.data).toHaveLength(1);
  });

  it("404s creating a version for an unknown skill", async () => {
    const res = await app.request("/skill_missing/versions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: [{ filename: "SKILL.md", content: SKILL_MD }] }),
    });
    expect(res.status).toBe(404);
  });
});

describe("skills routes — zip upload", () => {
  function zipBytes(files: Record<string, string>): Uint8Array {
    const enc: Record<string, Uint8Array> = {};
    for (const [name, content] of Object.entries(files)) {
      enc[name] = new TextEncoder().encode(content);
    }
    return zipSync(enc);
  }

  it("creates a skill from a zip, stripping a common top-level folder", async () => {
    const { app } = makeApp({});
    const bytes = zipBytes({
      "my-skill/SKILL.md": SKILL_MD,
      "my-skill/reference.txt": "extra content",
    });
    const form = new FormData();
    form.set("file", new File([bytes], "my-skill.zip"));
    const res = await app.request("/upload", { method: "POST", body: form });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.name).toBe("my-skill");
    expect(json.files.map((f: { filename: string }) => f.filename).sort()).toEqual([
      "SKILL.md",
      "reference.txt",
    ]);
  });

  it("rejects a zip with no SKILL.md (400)", async () => {
    const { app } = makeApp({});
    const bytes = zipBytes({ "notes.txt": "hello" });
    const form = new FormData();
    form.set("file", new File([bytes], "bad.zip"));
    const res = await app.request("/upload", { method: "POST", body: form });
    expect(res.status).toBe(400);
  });

  it("rejects a non-multipart body (400)", async () => {
    const { app } = makeApp({});
    const res = await app.request("/upload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(400);
  });

  it("adds a version from a zip", async () => {
    const { app } = makeApp({});
    const created = await (
      await app.request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ files: [{ filename: "SKILL.md", content: SKILL_MD }] }),
      })
    ).json();

    const bytes = zipBytes({ "SKILL.md": SKILL_MD, "more.txt": "v2 content" });
    const form = new FormData();
    form.set("file", new File([bytes], "v2.zip"));
    const res = await app.request(`/${created.id}/versions/upload`, { method: "POST", body: form });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.files).toHaveLength(2);
  });
});

describe("skills routes — quota gates", () => {
  it("soft-passes uploads when quota is undefined (default)", async () => {
    const { app } = makeApp({});
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: [{ filename: "SKILL.md", content: SKILL_MD }] }),
    });
    expect(res.status).toBe(201);
  });

  it("rejects with the quota's status/message when checkUploadSize rejects", async () => {
    const quota: QuotaService = {
      checkUploadSize: (): QuotaResult => ({ reject: true, status: 413, message: "too big" }),
      checkUploadFreq: async (): Promise<QuotaResult> => ({ reject: false }),
      checkDailySessionCap: async (): Promise<QuotaResult> => ({ reject: false }),
    };
    const { app } = makeApp({ quota });
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "999999" },
      body: JSON.stringify({ files: [{ filename: "SKILL.md", content: SKILL_MD }] }),
    });
    expect(res.status).toBe(413);
    const json = await res.json();
    expect(json.error).toBe("too big");
  });

  it("rejects with the quota's status/message when checkUploadFreq rejects", async () => {
    const quota: QuotaService = {
      checkUploadSize: (): QuotaResult => ({ reject: false }),
      checkUploadFreq: async (): Promise<QuotaResult> => ({
        reject: true,
        status: 429,
        message: "slow down",
      }),
      checkDailySessionCap: async (): Promise<QuotaResult> => ({ reject: false }),
    };
    const { app } = makeApp({ quota });
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: [{ filename: "SKILL.md", content: SKILL_MD }] }),
    });
    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json.error).toBe("slow down");
  });
});
