// Route-level coverage for the public CLI telemetry endpoints:
//   POST /v1/telemetry/events  (buildTelemetryRoutes)
//   GET  /v1/telemetry/stats   (buildTelemetryRoutes)
//
// Runs against the real D1 test binding + the real 0029 migration so a
// schema drift (renamed column, etc.) fails this test rather than silently
// passing against a hand-rolled fake table.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { CfD1SqlClient } from "@duyet/oma-sql-client/adapters/cf-d1";
import { buildTelemetryRoutes } from "./index";
import type { RouteServices } from "../types";
// @ts-expect-error ?raw is a Vite string import, no type decl
import telemetryMigration from "../../../../apps/main/migrations/0029_telemetry_events.sql?raw";
// @ts-expect-error ?raw is a Vite string import, no type decl
import installsMigration from "../../../../apps/main/migrations/0032_telemetry_installs.sql?raw";

function d1(): D1Database {
  return (env as unknown as { MAIN_DB: D1Database }).MAIN_DB;
}

async function applyRawMigration(raw: string) {
  const sql = raw
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .map((s) => `${s};`)
    .join("\n");
  await d1().exec(sql);
}

async function applyTelemetryMigration() {
  await applyRawMigration(telemetryMigration as string);
}

async function applyInstallsMigration() {
  await applyRawMigration(installsMigration as string);
}

function app(rateLimit?: (c: import("hono").Context) => Promise<boolean>) {
  const sqlClient = new CfD1SqlClient(d1());
  const services = { sql: sqlClient } as unknown as RouteServices;
  const wrapped = new Hono();
  wrapped.route("/v1/telemetry", buildTelemetryRoutes({ services, rateLimit }));
  return wrapped;
}

const validEvent = {
  event: "command" as const,
  command: "agent.create",
  cli_version: "0.1.5",
  os: "darwin",
  arch: "arm64",
  node_version: "22.1.0",
  machine_id: "a".repeat(64),
};

describe("POST /v1/telemetry/events", () => {
  beforeAll(applyTelemetryMigration);
  beforeEach(async () => {
    await d1().prepare("DELETE FROM telemetry_events").run();
  });

  it("accepts a valid event and inserts a row", async () => {
    const res = await app().request("/v1/telemetry/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validEvent),
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });

    const row = await d1()
      .prepare("SELECT * FROM telemetry_events WHERE command = ?")
      .bind("agent.create")
      .first<{ machine_id: string; os: string }>();
    expect(row?.machine_id).toBe(validEvent.machine_id);
    expect(row?.os).toBe("darwin");
  });

  it("rejects an invalid machine_id with 400", async () => {
    const res = await app().request("/v1/telemetry/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...validEvent, machine_id: "not-hex" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("rejects a body with an extra unknown key with 400", async () => {
    const res = await app().request("/v1/telemetry/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...validEvent, extra_field: "nope" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 429 when rateLimit reports limited", async () => {
    const res = await app(async () => true).request("/v1/telemetry/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validEvent),
    });
    expect(res.status).toBe(429);
    const body = (await res.json()) as any;
    expect(body.error.type).toBe("rate_limit_error");
  });
});

describe("GET /v1/telemetry/stats", () => {
  beforeAll(applyTelemetryMigration);
  beforeEach(async () => {
    await d1().prepare("DELETE FROM telemetry_events").run();
  });

  it("returns zeroed aggregates on an empty telemetry table", async () => {
    const res = await app().request("/v1/telemetry/stats");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.cli.total_commands).toBe(0);
    expect(body.cli.by_command).toEqual([]);
    expect(body.cli.by_platform).toEqual([]);
    expect(typeof body.generated_at).toBe("number");
    expect(typeof body.agents.total).toBe("number");
    expect(typeof body.sessions.total).toBe("number");
    expect(body.tasks.total).toBe(0);
  });

  it("aggregates by_command and by_platform after events are ingested", async () => {
    const post = (over: Partial<typeof validEvent>) =>
      app().request("/v1/telemetry/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...validEvent, ...over }),
      });
    await post({ command: "agent.create", os: "darwin" });
    await post({ command: "agent.create", os: "linux" });
    await post({ command: "session.list", os: "darwin" });

    const res = await app().request("/v1/telemetry/stats");
    const body = (await res.json()) as any;
    expect(body.cli.total_commands).toBe(3);
    const byCommand = Object.fromEntries(
      body.cli.by_command.map((r: { name: string; count: number }) => [r.name, r.count]),
    );
    expect(byCommand["agent.create"]).toBe(2);
    expect(byCommand["session.list"]).toBe(1);
    const byPlatform = Object.fromEntries(
      body.cli.by_platform.map((r: { platform: string; count: number }) => [r.platform, r.count]),
    );
    expect(byPlatform.darwin).toBe(2);
    expect(byPlatform.linux).toBe(1);
  });
});

const validReport = {
  instance_id: "11111111-1111-4111-8111-111111111111",
  oma_version: "0.1.0",
  deployment_kind: "node-docker" as const,
  agents_total: 3,
  agents_active: 2,
  sessions_total: 10,
  sessions_running: 1,
  session_duration_total_ms: 5000,
  session_duration_avg_ms: 2500,
  idle_time_total_ms: 0,
  sandbox_launches: { cloud: 2, boxrun: 1 },
  model_ids: ["claude-sonnet-4-6"],
};

interface SeedRow {
  id: string;
  instance_id: string;
  oma_version?: string | null;
  deployment_kind?: string | null;
  sessions_total?: number | null;
  session_duration_avg_ms?: number | null;
  sandbox_launches?: Record<string, number> | null;
  model_ids?: string[] | null;
  created_at: number;
}

async function seedInstall(row: SeedRow) {
  await d1()
    .prepare(
      `INSERT INTO telemetry_installs
         (id, instance_id, oma_version, deployment_kind, agents_total, agents_active,
          sessions_total, sessions_running, session_duration_total_ms,
          session_duration_avg_ms, idle_time_total_ms, sandbox_launches, model_ids, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.instance_id,
      row.oma_version ?? null,
      row.deployment_kind ?? null,
      0,
      0,
      row.sessions_total ?? null,
      0,
      0,
      row.session_duration_avg_ms ?? null,
      0,
      row.sandbox_launches ? JSON.stringify(row.sandbox_launches) : null,
      row.model_ids ? JSON.stringify(row.model_ids) : null,
      row.created_at,
    )
    .run();
}

describe("POST /v1/telemetry/ingest", () => {
  beforeAll(applyInstallsMigration);
  beforeEach(async () => {
    await d1().prepare("DELETE FROM telemetry_installs").run();
  });

  it("accepts a valid install report and inserts a row", async () => {
    const res = await app().request("/v1/telemetry/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validReport),
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });

    const row = await d1()
      .prepare("SELECT * FROM telemetry_installs WHERE instance_id = ?")
      .bind(validReport.instance_id)
      .first<{ deployment_kind: string; sessions_total: number; sandbox_launches: string }>();
    expect(row?.deployment_kind).toBe("node-docker");
    expect(row?.sessions_total).toBe(10);
    expect(JSON.parse(row?.sandbox_launches ?? "{}")).toEqual({ cloud: 2, boxrun: 1 });
  });

  it("rejects an invalid instance_id with 400", async () => {
    const res = await app().request("/v1/telemetry/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...validReport, instance_id: "not-a-uuid" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("rejects an unknown deployment_kind with 400", async () => {
    const res = await app().request("/v1/telemetry/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...validReport, deployment_kind: "windows" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a body with an extra unknown key with 400", async () => {
    const res = await app().request("/v1/telemetry/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...validReport, secret: "leak" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 429 when rateLimit reports limited", async () => {
    const res = await app(async () => true).request("/v1/telemetry/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validReport),
    });
    expect(res.status).toBe(429);
    const body = (await res.json()) as any;
    expect(body.error.type).toBe("rate_limit_error");
  });
});

describe("GET /v1/telemetry/stats — installs section", () => {
  beforeAll(applyInstallsMigration);
  beforeEach(async () => {
    await d1().prepare("DELETE FROM telemetry_installs").run();
  });

  it("aggregates only the latest report per instance", async () => {
    const now = Date.now();
    const instA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const instB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    // Instance A: an OLDER report that must be ignored, plus a NEWER one.
    await seedInstall({
      id: "row_a_old",
      instance_id: instA,
      oma_version: "0.0.9",
      deployment_kind: "cloudflare",
      sessions_total: 5,
      session_duration_avg_ms: 999,
      sandbox_launches: { cloud: 3 },
      model_ids: ["claude-sonnet-4-6"],
      created_at: now - 60_000,
    });
    await seedInstall({
      id: "row_a_new",
      instance_id: instA,
      oma_version: "0.1.0",
      deployment_kind: "node-docker",
      sessions_total: 10,
      session_duration_avg_ms: 2000,
      sandbox_launches: { cloud: 2, boxrun: 1 },
      model_ids: ["claude-haiku-4-5", "claude-sonnet-4-6"],
      created_at: now,
    });
    // Instance B: a single report.
    await seedInstall({
      id: "row_b",
      instance_id: instB,
      oma_version: "0.1.0",
      deployment_kind: "k8s",
      sessions_total: 7,
      session_duration_avg_ms: 4000,
      sandbox_launches: { "k8s-remote": 4 },
      model_ids: ["gpt-4o"],
      created_at: now,
    });

    const res = await app().request("/v1/telemetry/stats");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const installs = body.installs;

    // total = distinct instances (A + B), NOT the 3 raw rows.
    expect(installs.total).toBe(2);
    expect(installs.active).toBe(2);

    // Latest-per-instance wins: A's older "cloudflare" row is ignored.
    const kinds = Object.fromEntries(
      installs.by_deployment_kind.map((r: { kind: string; count: number }) => [r.kind, r.count]),
    );
    expect(kinds["node-docker"]).toBe(1);
    expect(kinds["k8s"]).toBe(1);
    expect(kinds["cloudflare"]).toBeUndefined();

    // sandbox_launches merged over latest rows only — cloud is 2 (A-new),
    // NOT 5 (would include A-old's 3). This is the load-bearing property.
    const sandbox = Object.fromEntries(
      installs.sandbox_launches.map((r: { kind: string; count: number }) => [r.kind, r.count]),
    );
    expect(sandbox.cloud).toBe(2);
    expect(sandbox.boxrun).toBe(1);
    expect(sandbox["k8s-remote"]).toBe(4);

    // sessions_reported = 10 (A-new) + 7 (B) = 17, NOT counting A-old's 5.
    expect(installs.sessions_reported).toBe(17);

    // simple average of latest avg durations: (2000 + 4000) / 2 = 3000.
    expect(installs.session_duration_avg_ms).toBe(3000);

    // model_mix over latest rows: sonnet (A-new) + haiku (A-new) + gpt-4o (B).
    const models = Object.fromEntries(
      installs.model_mix.map((r: { name: string; count: number }) => [r.name, r.count]),
    );
    expect(models["claude-sonnet-4-6"]).toBe(1);
    expect(models["claude-haiku-4-5"]).toBe(1);
    expect(models["gpt-4o"]).toBe(1);
  });

  it("returns zeroed installs aggregates on an empty table", async () => {
    const res = await app().request("/v1/telemetry/stats");
    const body = (await res.json()) as any;
    expect(body.installs.total).toBe(0);
    expect(body.installs.active).toBe(0);
    expect(body.installs.sessions_reported).toBe(0);
    expect(body.installs.session_duration_avg_ms).toBe(0);
    expect(body.installs.by_deployment_kind).toEqual([]);
    expect(body.installs.sandbox_launches).toEqual([]);
    expect(body.installs.model_mix).toEqual([]);
  });
});
