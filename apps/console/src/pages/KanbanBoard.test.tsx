import { describe, expect, it } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";
import { KanbanBoard } from "./KanbanBoard";

function renderBoard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <KanbanBoard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function session(overrides: Partial<{
  id: string;
  title: string;
  status: string;
  agentId: string;
  created_at: string;
}> = {}) {
  return {
    id: overrides.id ?? "ses_1",
    title: overrides.title ?? "A session",
    agent: { id: overrides.agentId ?? "agt_1", version: 1 },
    environment_id: "env_1",
    status: overrides.status ?? "idle",
    created_at: overrides.created_at ?? new Date().toISOString(),
  };
}

describe("<KanbanBoard />", () => {
  it("renders an empty state when there are no sessions", async () => {
    server.use(
      http.get("/v1/sessions", () => HttpResponse.json({ data: [] })),
    );
    renderBoard();
    expect(await screen.findByText("No sessions yet")).toBeInTheDocument();
  });

  it("places sessions into queued / running / blocked / done based on status + last event", async () => {
    const sessions = [
      session({ id: "ses_queued", status: "idle" }), // no events → queued
      session({ id: "ses_running", status: "running" }),
      session({ id: "ses_blocked", status: "idle" }), // requires_action → blocked
      session({ id: "ses_done", status: "idle" }), // end_turn → done
      session({ id: "ses_terminated", status: "terminated" }),
    ];

    server.use(
      http.get("/v1/sessions", () => HttpResponse.json({ data: sessions })),
      http.get("/v1/sessions/ses_queued/events", () => HttpResponse.json({ data: [] })),
      http.get("/v1/sessions/ses_blocked/events", () =>
        HttpResponse.json({
          data: [
            {
              seq: 3,
              type: "session.status_idle",
              data: { type: "session.status_idle", stop_reason: { type: "requires_action" } },
            },
          ],
        }),
      ),
      http.get("/v1/sessions/ses_done/events", () =>
        HttpResponse.json({
          data: [
            {
              seq: 5,
              type: "session.status_idle",
              data: { type: "session.status_idle", stop_reason: { type: "end_turn" } },
            },
          ],
        }),
      ),
    );

    renderBoard();

    await waitFor(() => {
      expect(screen.getByTestId("kanban-board")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(within(screen.getByTestId("kanban-column-queued")).getByText("1")).toBeInTheDocument();
    });
    expect(within(screen.getByTestId("kanban-column-running")).getByText("1")).toBeInTheDocument();
    expect(within(screen.getByTestId("kanban-column-blocked")).getByText("1")).toBeInTheDocument();
    expect(within(screen.getByTestId("kanban-column-done")).getByText("2")).toBeInTheDocument();
  });
});
