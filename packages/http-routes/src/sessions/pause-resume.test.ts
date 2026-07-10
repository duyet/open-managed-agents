// Route-level coverage for POST /v1/sessions/:id/pause and /:id/resume —
// the sandbox pause/resume API. Exercises the happy path, the 409
// in-flight-turn conflict, the 404 unknown-session path, and the
// resume/pause no-op shapes. Uses a minimal SessionRouter stub since only
// `pause`/`resume` are exercised by these routes.

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { buildSessionRoutes } from "./index";
import type { RouteServicesArg } from "../types";
import type { SessionRouter } from "@duyet/oma-session-runtime";

const TENANT = "tenant-1";
const SESSION_ID = "sess_1";

let knownSession: { id: string } | null = { id: SESSION_ID };
let pauseResult: { status: number; body: string } = {
  status: 200,
  body: JSON.stringify({ sandbox_status: "paused" }),
};
let resumeResult: { status: number; body: string } = {
  status: 200,
  body: JSON.stringify({ sandbox_status: "running" }),
};
let pauseCalls: string[] = [];
let resumeCalls: string[] = [];

function makeApp() {
  const services = {
    sessions: {
      get: async ({ sessionId }: { sessionId: string }) =>
        knownSession && knownSession.id === sessionId ? knownSession : null,
    },
  } as unknown as RouteServicesArg;

  const router: Partial<SessionRouter> = {
    pause: async (sessionId: string) => {
      pauseCalls.push(sessionId);
      return pauseResult;
    },
    resume: async (sessionId: string) => {
      resumeCalls.push(sessionId);
      return resumeResult;
    },
  };

  const app = new Hono<{ Variables: { tenant_id: string } }>();
  app.use("*", async (c, next) => {
    c.set("tenant_id", TENANT);
    await next();
  });
  app.route(
    "/v1/sessions",
    buildSessionRoutes({ services, router: router as SessionRouter }),
  );
  return app;
}

describe("session pause/resume routes", () => {
  beforeEach(() => {
    knownSession = { id: SESSION_ID };
    pauseResult = { status: 200, body: JSON.stringify({ sandbox_status: "paused" }) };
    resumeResult = { status: 200, body: JSON.stringify({ sandbox_status: "running" }) };
    pauseCalls = [];
    resumeCalls = [];
  });

  it("POST /:id/pause returns { id, sandbox_status: paused } on success", async () => {
    const app = makeApp();
    const res = await app.request(`/v1/sessions/${SESSION_ID}/pause`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: SESSION_ID, sandbox_status: "paused" });
    expect(pauseCalls).toEqual([SESSION_ID]);
  });

  it("POST /:id/pause 404s for an unknown session without calling the router", async () => {
    knownSession = null;
    const app = makeApp();
    const res = await app.request(`/v1/sessions/${SESSION_ID}/pause`, { method: "POST" });
    expect(res.status).toBe(404);
    expect(pauseCalls).toEqual([]);
  });

  it("POST /:id/pause 409s when the session has an in-flight turn", async () => {
    pauseResult = {
      status: 409,
      body: JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", message: "Cannot pause a session with an in-flight turn" },
      }),
    };
    const app = makeApp();
    const res = await app.request(`/v1/sessions/${SESSION_ID}/pause`, { method: "POST" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/in-flight turn/);
  });

  it("POST /:id/resume returns { id, sandbox_status: running } on success", async () => {
    const app = makeApp();
    const res = await app.request(`/v1/sessions/${SESSION_ID}/resume`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: SESSION_ID, sandbox_status: "running" });
    expect(resumeCalls).toEqual([SESSION_ID]);
  });

  it("POST /:id/resume 404s for an unknown session without calling the router", async () => {
    knownSession = null;
    const app = makeApp();
    const res = await app.request(`/v1/sessions/${SESSION_ID}/resume`, { method: "POST" });
    expect(res.status).toBe(404);
    expect(resumeCalls).toEqual([]);
  });

  it("POST /:id/resume on a non-paused session is a 200 no-op", async () => {
    const app = makeApp();
    const res = await app.request(`/v1/sessions/${SESSION_ID}/resume`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: SESSION_ID, sandbox_status: "running" });
  });
});
