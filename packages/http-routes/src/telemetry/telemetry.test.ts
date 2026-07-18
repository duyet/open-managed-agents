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

function d1(): D1Database {
  return (env as unknown as { MAIN_DB: D1Database }).MAIN_DB;
}

async function applyTelemetryMigration() {
  const sql = (telemetryMigration as string)
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
