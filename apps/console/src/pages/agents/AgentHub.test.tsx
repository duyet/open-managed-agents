import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";

import { server } from "../../mocks/server";
import { ConfirmProvider } from "../../hooks/useConfirm";
import { AgentDetail } from "../AgentDetail";
import { AgentOverviewTab } from "./AgentOverviewTab";
import { AgentSessionsTab } from "./AgentSessionsTab";
import { AgentDeploymentsTab } from "./AgentDeploymentsTab";
import { AgentPublishingTab } from "./AgentPublishingTab";

const agentV2 = {
  id: "agent_1",
  name: "My Agent",
  model: "claude-new",
  system: "NEW SYSTEM PROMPT",
  version: 2,
  tools: [{ type: "agent_toolset_20260401" }],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
};
const agentV1 = {
  ...agentV2,
  model: "claude-old",
  system: "OLD SYSTEM PROMPT",
  version: 1,
};

function mountHubHandlers() {
  server.use(
    http.get("/v1/agents/agent_1", () => HttpResponse.json(agentV2)),
    http.get("/v1/agents/agent_1/versions", () =>
      HttpResponse.json({ data: [agentV1, agentV2] }),
    ),
    http.get("/v1/integrations/:provider/agents/agent_1/publications", () =>
      HttpResponse.json({ data: [] }),
    ),
    http.get("/v1/sessions", () => HttpResponse.json({ data: [] })),
    http.get("/v1/deployments", () => HttpResponse.json({ data: [] })),
    http.get("/v1/agents/agent_1/publications", () => HttpResponse.json({ data: [] })),
  );
}

function renderHub(initial = "/agents/agent_1") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={[initial]}>
          <Routes>
            <Route path="/agents/:id" element={<AgentDetail />}>
              <Route index element={<AgentOverviewTab />} />
              <Route path="sessions" element={<AgentSessionsTab />} />
              <Route path="deployments" element={<AgentDeploymentsTab />} />
              <Route path="publishing" element={<AgentPublishingTab />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ConfirmProvider>
    </QueryClientProvider>,
  );
}

describe("<AgentDetail /> hub layout", () => {
  beforeEach(mountHubHandlers);

  it("renders the header + tab strip once the agent loads", async () => {
    renderHub();
    expect(await screen.findByRole("heading", { name: "My Agent" })).toBeInTheDocument();
    // Tab strip — real nested-route links.
    expect(screen.getByRole("link", { name: "Agent" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sessions" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Deployments" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Observability" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Publishing" })).toBeInTheDocument();
    // Active tab (Agent) shows the config view.
    expect(screen.getByRole("heading", { name: "System Prompt" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Version:/ })).toBeInTheDocument();
  });

  it("navigates to the Sessions tab and shows its empty state", async () => {
    renderHub();
    await screen.findByRole("heading", { name: "My Agent" });
    await userEvent.click(screen.getByRole("link", { name: "Sessions" }));
    expect(await screen.findByText("No sessions yet")).toBeInTheDocument();
  });

  it("navigates to the Deployments tab and shows the No deployments empty state", async () => {
    renderHub();
    await screen.findByRole("heading", { name: "My Agent" });
    await userEvent.click(screen.getByRole("link", { name: "Deployments" }));
    expect(await screen.findByText("No deployments")).toBeInTheDocument();
    expect(
      screen.getByText("Deploy this agent to run it on a schedule, via webhook, or manually."),
    ).toBeInTheDocument();
  });

  it("navigates to the Publishing tab and shows the Not published empty state", async () => {
    renderHub();
    await screen.findByRole("heading", { name: "My Agent" });
    await userEvent.click(screen.getByRole("link", { name: "Publishing" }));
    expect(await screen.findByText("Not published")).toBeInTheDocument();
    expect(
      screen.getByText("Publish this agent to share a public chat page, embed widget, or QR code."),
    ).toBeInTheDocument();
  });
});

describe("<AgentOverviewTab /> version picker", () => {
  beforeEach(mountHubHandlers);

  it("switches the viewed version and shows the historical banner", async () => {
    renderHub();
    await screen.findByRole("heading", { name: "My Agent" });

    // Default: latest (v2).
    const trigger = screen.getByRole("button", { name: /Version:/ });
    expect(trigger).toHaveTextContent("v2");
    expect(screen.queryByText(/Viewing v1/)).not.toBeInTheDocument();

    // Open the picker and select v1.
    await userEvent.click(trigger);
    const item = await screen.findByRole("menuitemcheckbox", { name: /^v1/ });
    await userEvent.click(item);

    // Banner appears; the config now reflects v1.
    expect(
      await screen.findByText(/Viewing v1 — the active version is v2/),
    ).toBeInTheDocument();
    const pre = document.querySelector("pre");
    expect(pre).toHaveTextContent("OLD SYSTEM PROMPT");

    // Back-to-latest clears the banner.
    await userEvent.click(screen.getByRole("button", { name: "Back to latest" }));
    await waitFor(() =>
      expect(screen.queryByText(/Viewing v1/)).not.toBeInTheDocument(),
    );
  });
});
