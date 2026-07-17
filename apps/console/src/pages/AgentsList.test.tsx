import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";

import { server } from "../mocks/server";
import { ConfirmProvider } from "../hooks/useConfirm";
import { AgentsList } from "./AgentsList";

const agent = {
  id: "agent_1",
  name: "My Agent",
  model: "claude-sonnet-4-6",
  system: "You are helpful.",
  version: 1,
  tools: [{ type: "agent_toolset_20260401" }],
  created_at: "2026-01-01T00:00:00Z",
};

function mountHandlers() {
  server.use(
    http.get("/v1/agents", () => HttpResponse.json({ data: [agent] })),
    http.get("/v1/skills", () => HttpResponse.json({ data: [] })),
    http.get("/v1/model_cards", () => HttpResponse.json({ data: [] })),
    http.get("/v1/runtimes", () => HttpResponse.json({ runtimes: [] })),
  );
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={["/agents"]}>
          <AgentsList />
        </MemoryRouter>
      </ConfirmProvider>
    </QueryClientProvider>,
  );
}

describe("<AgentsList /> row actions", () => {
  it("renders the expanded actions menu for a row", async () => {
    mountHandlers();
    renderPage();

    await waitFor(() => expect(screen.getByText("My Agent")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "Actions for My Agent" }));

    expect(screen.getByText("Open chat")).toBeInTheDocument();
    expect(screen.getByText("View sessions")).toBeInTheDocument();
    expect(screen.getByText("Edit")).toBeInTheDocument();
    expect(screen.getByText("Duplicate")).toBeInTheDocument();
    expect(screen.getByText("Copy agent ID")).toBeInTheDocument();
    expect(screen.getByText("Publish…")).toBeInTheDocument();
    expect(screen.getByText("Archive")).toBeInTheDocument();
    expect(screen.getByText("Delete")).toBeInTheDocument();
  });

  it("asks for confirmation before archiving and calls the archive endpoint on confirm", async () => {
    mountHandlers();
    let archiveCalled = false;
    server.use(
      http.post("/v1/agents/agent_1/archive", () => {
        archiveCalled = true;
        return HttpResponse.json({ ...agent, archived_at: "2026-01-02T00:00:00Z" });
      }),
    );
    renderPage();

    await waitFor(() => expect(screen.getByText("My Agent")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Actions for My Agent" }));
    await userEvent.click(screen.getByText("Archive"));

    // Confirm dialog appears; archive endpoint isn't hit until confirmed.
    await waitFor(() => expect(screen.getByText("Archive My Agent?")).toBeInTheDocument());
    expect(archiveCalled).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "Archive" }));

    await waitFor(() => expect(archiveCalled).toBe(true));
  });

  it("does not call the archive endpoint when the confirm dialog is cancelled", async () => {
    mountHandlers();
    let archiveCalled = false;
    server.use(
      http.post("/v1/agents/agent_1/archive", () => {
        archiveCalled = true;
        return HttpResponse.json({});
      }),
    );
    renderPage();

    await waitFor(() => expect(screen.getByText("My Agent")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Actions for My Agent" }));
    await userEvent.click(screen.getByText("Archive"));

    await waitFor(() => expect(screen.getByText("Archive My Agent?")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(archiveCalled).toBe(false);
  });
});
