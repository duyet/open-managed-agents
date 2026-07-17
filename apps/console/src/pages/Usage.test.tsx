import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";
import { Usage } from "./Usage";

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Usage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const fullUsage = {
  period: { days: 0, since: null },
  total_active_seconds: 4 * 3600 + 32 * 60, // 4h 32m
  total_sessions: 12,
  by_kind: [
    { kind: "sandbox_active_seconds", total: 4 * 3600 + 32 * 60 },
    { kind: "model_input_tokens", total: 105000 },
    { kind: "model_output_tokens", total: 7500 },
  ],
  by_instance_type: [{ instance_type: "standard-1", total_seconds: 3600 }],
  daily: [
    { date: "2026-07-15", active_seconds: 600, runs: 2 },
    { date: "2026-07-16", active_seconds: 1200, runs: 3 },
  ],
  by_agent: [
    {
      agent_id: "agent_1",
      agent_name: "Research Bot",
      total_active_seconds: 3600,
      total_sessions: 8,
      by_kind: [
        { kind: "model_input_tokens", total: 80000 },
        { kind: "model_output_tokens", total: 6000 },
      ],
    },
    {
      agent_id: null,
      agent_name: null,
      total_active_seconds: 1920,
      total_sessions: 4,
      by_kind: [{ kind: "model_input_tokens", total: 25000 }],
    },
  ],
};

const emptyUsage = {
  period: { days: 0, since: null },
  total_active_seconds: 0,
  total_sessions: 0,
  by_kind: [],
  by_instance_type: [],
  daily: [],
  by_agent: [],
};

const fullCostReport = {
  available: true,
  period: { start: "2026-06-17", end: "2026-07-17", days: 30 },
  platform_fee: 5,
  services: {
    workers: { usage: { requests: 10000, errors: 2 }, included: { requests: 10_000_000 }, cost: 0.12 },
    kv: { usage: { read: 500, write: 10 }, included: { read: 10_000_000 }, cost: 0 },
  },
  total_estimated_cost: 5.12,
};

describe("<Usage />", () => {
  it("renders all-time stats, daily activity, breakdown tables, and Cloudflare cost", async () => {
    server.use(
      http.get("/v1/usage", () => HttpResponse.json(fullUsage)),
      http.get("/v1/cost_report", () => HttpResponse.json(fullCostReport)),
    );
    renderPage();

    expect(await screen.findByText("All time")).toBeInTheDocument();
    // Each of these renders twice by design — once in the all-time stat
    // tile row, once in the "By kind" table row for the same usage_events
    // kind (both derive from the same underlying by_kind entry).
    expect(screen.getAllByText("4h 32m")).toHaveLength(2); // sandbox time
    expect(screen.getAllByText("105K")).toHaveLength(2); // tokens in
    expect(screen.getAllByText("7.5K")).toHaveLength(2); // tokens out

    expect(screen.getByText("Daily activity")).toBeInTheDocument();
    expect(screen.getByText("By kind")).toBeInTheDocument();
    expect(screen.getByText("Sandbox active time")).toBeInTheDocument();
    expect(screen.getByText("Model input tokens")).toBeInTheDocument();
    expect(screen.getByText("Model output tokens")).toBeInTheDocument();
    expect(screen.getByText("By sandbox instance type")).toBeInTheDocument();
    expect(screen.getByText("standard-1")).toBeInTheDocument();

    expect(screen.getByText("By agent")).toBeInTheDocument();
    expect(screen.getByText("Research Bot")).toBeInTheDocument();
    expect(screen.getByText("Unattributed")).toBeInTheDocument();
    expect(screen.getByText("80K")).toBeInTheDocument(); // agent_1 tokens in
    expect(screen.getByText("25K")).toBeInTheDocument(); // unattributed tokens in

    expect(await screen.findByText("$5.12")).toBeInTheDocument();
    expect(screen.getByText("Workers")).toBeInTheDocument();
  });

  // #231 — the "All time" tiles must stay genuinely all-time now that the
  // server defaults ?days= to 30, and the per-agent table needs group_by.
  it("requests /v1/usage with days=0 and group_by=agent", async () => {
    let lastParams: URLSearchParams | null = null;
    server.use(
      http.get("/v1/usage", ({ request }) => {
        lastParams = new URL(request.url).searchParams;
        return HttpResponse.json(fullUsage);
      }),
      http.get("/v1/cost_report", () => HttpResponse.json(fullCostReport)),
    );
    renderPage();

    await screen.findByText("All time");
    expect(lastParams!.get("days")).toBe("0");
    expect(lastParams!.get("group_by")).toBe("agent");
  });

  // A failed /v1/usage fetch must render the error+Retry state, never the
  // empty-state copy (matches the #182/#218 list-UX contract) — and must
  // NOT hide the independently-fetched Cloudflare cost card.
  it("shows an error state with Retry when /v1/usage fails, without hiding Cloudflare cost", async () => {
    server.use(
      http.get("/v1/usage", () => HttpResponse.json({ error: "Internal error" }, { status: 500 })),
      http.get("/v1/cost_report", () => HttpResponse.json(fullCostReport)),
    );
    renderPage();

    await waitFor(() => expect(screen.getByText("Couldn't load usage")).toBeInTheDocument());
    expect(screen.getByText("Internal error")).toBeInTheDocument();
    expect(screen.queryByText("No usage in this period")).not.toBeInTheDocument();

    // Cloudflare cost is a separate fetch — still renders normally.
    expect(await screen.findByText("$5.12")).toBeInTheDocument();

    const retryButton = screen.getByRole("button", { name: "Retry" });
    server.use(http.get("/v1/usage", () => HttpResponse.json(fullUsage)));
    await userEvent.click(retryButton);

    await waitFor(() => expect(screen.getByText("All time")).toBeInTheDocument());
    expect(screen.queryByText("Couldn't load usage")).not.toBeInTheDocument();
  });

  it('shows "No usage in this period" when the tenant has recorded nothing', async () => {
    server.use(
      http.get("/v1/usage", () => HttpResponse.json(emptyUsage)),
      http.get("/v1/cost_report", () => HttpResponse.json(fullCostReport)),
    );
    renderPage();

    expect(await screen.findByText("No usage in this period")).toBeInTheDocument();
  });

  // /v1/cost_report degrades to 200 with { available: false, reason } when
  // CLOUDFLARE_API_TOKEN/ACCOUNT_ID aren't configured — an expected "not set
  // up" signal, not a failure. It must render a calm inline note (with a docs
  // link) rather than the red error+Retry state, and — crucially — a 2xx must
  // NOT fire the app's global error toast the way the old 501 did.
  it("shows a quiet inline note (not an error) when Cloudflare cost reporting isn't configured", async () => {
    server.use(
      http.get("/v1/usage", () => HttpResponse.json(fullUsage)),
      http.get("/v1/cost_report", () =>
        HttpResponse.json({
          available: false,
          reason: "cloudflare_credentials_not_configured",
        }),
      ),
    );
    renderPage();

    expect(await screen.findByText("Cloudflare infra cost unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load Cloudflare cost")).not.toBeInTheDocument();

    // The docs link points at the configuration reference.
    const docsLink = screen.getByRole("link", { name: "Configuration docs" });
    expect(docsLink).toHaveAttribute(
      "href",
      "https://docs.oma.duyet.net/reference/configuration/",
    );
  });

  it("re-fetches the Cloudflare cost report with the selected range's days param", async () => {
    let lastDays: string | null = null;
    server.use(
      http.get("/v1/usage", () => HttpResponse.json(fullUsage)),
      http.get("/v1/cost_report", ({ request }) => {
        lastDays = new URL(request.url).searchParams.get("days");
        return HttpResponse.json(fullCostReport);
      }),
    );
    renderPage();

    await screen.findByText("$5.12");
    expect(lastDays).toBe("30");

    await userEvent.click(screen.getByRole("button", { name: "7d" }));

    await waitFor(() => expect(lastDays).toBe("7"));
  });
});
