import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";
import { Dashboard } from "./Dashboard";

// Dashboard also renders <StackedAssembly />, which fans out to a handful
// of `?limit=10` resource lists plus three integration-installation
// lookups. None of those bear on the metric-card assertions below, so
// they're stubbed to empty lists — the point is to prove the new headline
// cards render from /v1/stats + /v1/sessions without crashing the rest of
// the page (onUnhandledRequest: "error" would fail the test otherwise).
function mockAssemblyDeps() {
  server.use(
    ...[
      "/v1/agents",
      "/v1/model_cards",
      "/v1/skills",
      "/v1/environments",
      "/v1/vaults",
      "/v1/publications",
      "/v1/api_keys",
      "/v1/memory_stores",
      "/v1/files",
    ].map((path) => http.get(path, () => HttpResponse.json({ data: [] }))),
    http.get("/v1/integrations/linear/installations", () =>
      HttpResponse.json({ data: [] }),
    ),
    http.get("/v1/integrations/github/installations", () =>
      HttpResponse.json({ data: [] }),
    ),
    http.get("/v1/integrations/slack/installations", () =>
      HttpResponse.json({ data: [] }),
    ),
  );
}

function mockSessions({
  recent = [],
  running = [],
  runningHasMore = false,
}: {
  recent?: unknown[];
  running?: unknown[];
  runningHasMore?: boolean;
}) {
  server.use(
    http.get("/v1/sessions", ({ request }) => {
      const url = new URL(request.url);
      if (url.searchParams.get("status") === "running") {
        return HttpResponse.json({
          data: running,
          ...(runningHasMore ? { next_page: "cursor_abc" } : {}),
        });
      }
      return HttpResponse.json({ data: recent });
    }),
  );
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Scope a query to one metric card so "2"/"Agents" don't collide with the
 *  StackedAssembly step badges or the pre-existing resource-count row. */
function metricCard(label: string) {
  return within(screen.getByTestId(`metric-card-${label}`));
}

describe("<Dashboard />", () => {
  it("renders the headline metric cards from /v1/stats + /v1/sessions", async () => {
    mockAssemblyDeps();
    mockSessions({
      recent: [],
      running: [{ id: "sess_1" }, { id: "sess_2" }],
    });
    server.use(
      http.get("/v1/stats", () =>
        HttpResponse.json({
          agents: 3,
          sessions: 42,
          environments: 2,
          vaults: 1,
          skills: 5,
          model_cards: 1,
          api_keys: 1,
          total_sandbox_seconds: 4 * 3600 + 32 * 60, // 4h 32m
          total_usage_sessions: 128,
        }),
      ),
    );

    renderPage();

    await waitFor(() =>
      expect(metricCard("Sandbox time").getByText("4h 32m")).toBeInTheDocument(),
    );
    expect(metricCard("Sandbox time").getByText("all time")).toBeInTheDocument();
    expect(metricCard("Sessions run").getByText("128")).toBeInTheDocument();
    expect(metricCard("Sessions run").getByText("all time")).toBeInTheDocument();
    expect(metricCard("Active sessions").getByText("2")).toBeInTheDocument();
    expect(metricCard("Active sessions").getByText("right now")).toBeInTheDocument();
    expect(metricCard("Agents").getByText("3")).toBeInTheDocument();
    // "Agents" also appears in the pre-existing resource-count row below —
    // the existing feature must still render alongside the new one.
    expect(screen.getAllByText("Agents").length).toBeGreaterThanOrEqual(2);
  });

  it("renders intentional empty states when there's no usage yet", async () => {
    mockAssemblyDeps();
    mockSessions({ recent: [], running: [] });
    server.use(
      http.get("/v1/stats", () =>
        HttpResponse.json({
          agents: 0,
          sessions: 0,
          environments: 0,
          vaults: 0,
          skills: 0,
          model_cards: 0,
          api_keys: 0,
          total_sandbox_seconds: 0,
          total_usage_sessions: 0,
        }),
      ),
    );

    renderPage();

    // Sandbox time renders an em-dash rather than a broken "0h 0m".
    await waitFor(() =>
      expect(metricCard("Sandbox time").getByText("—")).toBeInTheDocument(),
    );
    expect(metricCard("Sandbox time").getByText("No usage yet")).toBeInTheDocument();
    expect(metricCard("Sessions run").getByText("No usage yet")).toBeInTheDocument();
    expect(metricCard("Agents").getByText("No agents yet")).toBeInTheDocument();
    // Zero active sessions is a normal steady state, not an error — it
    // still reads as a plain "0", not a dash.
    expect(metricCard("Active sessions").getByText("0")).toBeInTheDocument();
  });

  it("marks active sessions with a '+' when more running sessions exist than the fetched page", async () => {
    mockAssemblyDeps();
    mockSessions({
      recent: [],
      running: Array.from({ length: 100 }, (_, i) => ({ id: `sess_${i}` })),
      runningHasMore: true,
    });
    server.use(
      http.get("/v1/stats", () =>
        HttpResponse.json({
          agents: 1,
          sessions: 1,
          environments: 1,
          vaults: 1,
          skills: 1,
          model_cards: 1,
          api_keys: 1,
          total_sandbox_seconds: 60,
          total_usage_sessions: 1,
        }),
      ),
    );

    renderPage();

    await waitFor(() =>
      expect(metricCard("Active sessions").getByText("100+")).toBeInTheDocument(),
    );
  });
});
