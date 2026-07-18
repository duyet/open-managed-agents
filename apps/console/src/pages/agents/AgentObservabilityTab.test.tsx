import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";

import { server } from "../../mocks/server";
import { AgentObservabilityTab } from "./AgentObservabilityTab";
import type { AgentHubContext } from "../AgentDetail";
import type { AgentRecord } from "../../types/agent";

const agent: AgentRecord = {
  id: "agent_1",
  name: "My Agent",
  model: "claude-new",
  version: 2,
  created_at: "2026-01-01T00:00:00Z",
};

const ctx: AgentHubContext = {
  pageHeaderSlot: null,
  agent,
  versions: [agent],
  refetchAgent: () => {},
  refetchVersions: () => {},
};

const stats = {
  sessions: 12,
  input_tokens: 105000,
  output_tokens: 7500,
  sandbox_seconds: 3600,
  est_model_cost_usd: 1.23,
  est_sandbox_cost_usd: 0.4,
  cache_read_tokens: 45000,
  cache_creation_tokens: 12000,
  reasoning_tokens: 3000,
  cache_hit_ratio: 0.3,
};

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Routes>
          <Route element={<Outlet context={ctx} />}>
            <Route path="*" element={<AgentObservabilityTab />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("<AgentObservabilityTab />", () => {
  it("renders stat cards + activity + stop reasons when there is data", async () => {
    server.use(
      http.get("/v1/agents/agent_1/stats", () => HttpResponse.json(stats)),
      http.get("/v1/agents/agent_1/analytics", () =>
        HttpResponse.json({
          range: "30d",
          total_sessions: 8,
          completed_sessions: 8,
          error_count: 2,
          error_rate: 0.25,
          tokens: {
            input: 105000,
            output: 7500,
            total: 112500,
            per_session: {
              input: { p50: 5000, p90: 12000, p95: 15000 },
              output: { p50: 800, p90: 1500, p95: 2000 },
              total: { p50: 5800, p90: 13500, p95: 17000 },
            },
          },
          total_turns: 40,
          turns_per_session: { p50: 5, p90: 9, p95: 11 },
          total_tool_calls: 30,
          sessions_over_time: [
            { date: "2026-06-01", count: 3 },
            { date: "2026-06-02", count: 0 },
            { date: "2026-06-03", count: 5 },
          ],
          stop_reasons: [
            { stop_reason: "end_turn", count: 6 },
            { stop_reason: "destroyed", count: 2 },
          ],
        }),
      ),
    );
    renderTab();

    // All-time row + range-scoped stat cards.
    expect(await screen.findByText("All time")).toBeInTheDocument();
    // All-time cache/reasoning breakdown from /stats.
    expect(screen.getByText("Cache read")).toBeInTheDocument();
    expect(screen.getByText("45K")).toBeInTheDocument();
    expect(screen.getByText("Cache hit ratio")).toBeInTheDocument();
    expect(screen.getByText("30%")).toBeInTheDocument();
    expect(await screen.findByText("Session activity")).toBeInTheDocument();
    expect(screen.getByText("Error rate")).toBeInTheDocument();
    expect(screen.getByText("25.0%")).toBeInTheDocument();
    // Stop-reason legend.
    expect(screen.getByText("end_turn")).toBeInTheDocument();
    expect(screen.getByText("destroyed")).toBeInTheDocument();
  });

  it("shows a friendly empty state when the range has no sessions", async () => {
    server.use(
      http.get("/v1/agents/agent_1/stats", () => HttpResponse.json(stats)),
      http.get("/v1/agents/agent_1/analytics", () =>
        HttpResponse.json({
          range: "30d",
          total_sessions: 0,
          completed_sessions: 0,
          error_count: 0,
          error_rate: 0,
          tokens: {
            input: 0,
            output: 0,
            total: 0,
            per_session: {
              input: { p50: 0, p90: 0, p95: 0 },
              output: { p50: 0, p90: 0, p95: 0 },
              total: { p50: 0, p90: 0, p95: 0 },
            },
          },
          total_turns: 0,
          turns_per_session: { p50: 0, p90: 0, p95: 0 },
          total_tool_calls: 0,
          sessions_over_time: [],
          stop_reasons: [],
        }),
      ),
    );
    renderTab();

    expect(await screen.findByText("No activity in this range")).toBeInTheDocument();
    expect(screen.queryByText("Session activity")).not.toBeInTheDocument();
  });
});
