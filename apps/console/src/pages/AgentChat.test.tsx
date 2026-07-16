import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";
import { AgentChat } from "./AgentChat";

function renderChat() {
  return render(
    <MemoryRouter initialEntries={["/publish/agt_1"]}>
      <Routes>
        <Route path="/publish/:agent_id" element={<AgentChat />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("<AgentChat /> — publish chat (#180)", () => {
  it("creates the session with { agent } (not { agent_id }) and streams the reply", async () => {
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
    await userEvent.type(screen.getByPlaceholderText(/type a message/i), "ping");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    // The regression: the create body must carry `agent`, which the
    // session-create API reads — `agent_id` produced a 400 for every message.
    await waitFor(() => expect(createBody).toEqual({ agent: "agt_1" }));
    // …and the streamed agent reply renders.
    await waitFor(() => expect(screen.getByText("pong")).toBeInTheDocument());
  });

  it("surfaces the server's error message when create fails", async () => {
    server.use(
      http.post("/v1/sessions", () =>
        HttpResponse.json({ error: "agent is required" }, { status: 400 }),
      ),
    );

    renderChat();
    await userEvent.type(screen.getByPlaceholderText(/type a message/i), "ping");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    // readApiError pulls the server message through, instead of a generic
    // "Failed to create session".
    await waitFor(() =>
      expect(screen.getByText(/agent is required/i)).toBeInTheDocument(),
    );
  });
});
