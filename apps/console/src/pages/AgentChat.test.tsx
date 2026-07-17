import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";
import { AgentChat } from "./AgentChat";

function renderChat() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/publish/agt_1"]}>
        <Routes>
          <Route path="/publish/:agent_id" element={<AgentChat />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Cloud agent (no runtime_binding) with exactly one tenant environment —
 *  the auto-pick path, no picker shown. */
function mockSingleEnvAgent() {
  server.use(
    http.get("/v1/agents/agt_1", () => HttpResponse.json({ id: "agt_1" })),
    http.get("/v1/environments", () =>
      HttpResponse.json({ data: [{ id: "env_1", name: "Default" }] }),
    ),
  );
}

describe("<AgentChat /> — publish chat (#180)", () => {
  it("creates the session with { agent, environment_id } and streams the reply — single-env auto-pick", async () => {
    mockSingleEnvAgent();
    let createBody: unknown = null;
    server.use(
      http.post("/v1/sessions", async ({ request }) => {
        createBody = await request.json();
        return HttpResponse.json({ id: "sess_1" });
      }),
      http.post(
        "/v1/sessions/sess_1/messages",
        () =>
          new HttpResponse(
            'data: {"type":"agent.message","content":[{"text":"pong"}]}\n\n',
            { headers: { "content-type": "text/event-stream" } },
          ),
      ),
    );

    renderChat();
    // Wait for the agent + environment fetches to resolve (single-env
    // auto-pick) before the composer becomes usable.
    await waitFor(() =>
      expect(screen.getByPlaceholderText(/type a message/i)).not.toBeDisabled(),
    );
    await userEvent.type(screen.getByPlaceholderText(/type a message/i), "ping");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    // The regression: the create body must carry `agent`, which the
    // session-create API reads — `agent_id` produced a 400 for every message.
    // The tenant's single environment is picked silently and sent along, so
    // the backend's `environment_id is required for cloud agents` check
    // never fires.
    await waitFor(() =>
      expect(createBody).toEqual({ agent: "agt_1", environment_id: "env_1" }),
    );
    // …and the streamed agent reply renders.
    await waitFor(() => expect(screen.getByText("pong")).toBeInTheDocument());
  });

  it("surfaces the server's error message when create fails", async () => {
    mockSingleEnvAgent();
    server.use(
      http.post("/v1/sessions", () =>
        HttpResponse.json({ error: "agent is required" }, { status: 400 }),
      ),
    );

    renderChat();
    await waitFor(() =>
      expect(screen.getByPlaceholderText(/type a message/i)).not.toBeDisabled(),
    );
    await userEvent.type(screen.getByPlaceholderText(/type a message/i), "ping");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    // readApiError pulls the server message through, instead of a generic
    // "Failed to create session".
    await waitFor(() =>
      expect(screen.getByText(/agent is required/i)).toBeInTheDocument(),
    );
  });

  it("shows a CTA instead of a blind 400 when the tenant has no environments", async () => {
    server.use(
      http.get("/v1/agents/agt_1", () => HttpResponse.json({ id: "agt_1" })),
      http.get("/v1/environments", () => HttpResponse.json({ data: [] })),
    );

    renderChat();

    await waitFor(() =>
      expect(screen.getByText(/create an environment/i)).toBeInTheDocument(),
    );
    // The composer is disabled so the user can't fire a doomed request.
    expect(screen.getByPlaceholderText(/type a message/i)).toBeDisabled();
    expect(screen.getByRole("button", { name: /send/i })).toBeDisabled();
  });
});
