import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";
import { StackedAssembly } from "./StackedAssembly";

// The component fans out to a list endpoint per piece it draws. Every test
// stubs all of them (setup runs msw with onUnhandledRequest: "error"), then
// overrides just the ones under test — so a forgotten endpoint fails loudly
// instead of silently rendering an empty card.
const LIST_PATHS = [
  "/v1/agents",
  "/v1/model_cards",
  "/v1/mcp_servers",
  "/v1/skills",
  "/v1/environments",
  "/v1/vaults",
  "/v1/publications",
  "/v1/api_keys",
  "/v1/sessions",
];

function mockLists(overrides: Record<string, unknown[]> = {}) {
  server.use(
    ...LIST_PATHS.map((path) =>
      http.get(path, () => HttpResponse.json({ data: overrides[path] ?? [] })),
    ),
    ...["linear", "github", "slack"].map((p) =>
      http.get(`/v1/integrations/${p}/installations`, () =>
        HttpResponse.json({ data: [] }),
      ),
    ),
  );
}

function renderAssembly() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <StackedAssembly />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("<StackedAssembly />", () => {
  it("draws the four flow steps in configure → compose → run → reach order", async () => {
    mockLists();
    renderAssembly();

    // Steps are rendered as "1 · Configure" etc. Matching on a regex keeps
    // the assertion about the *flow*, not the separator glyph.
    const steps = await screen.findAllByText(
      /^[1-4] · (Configure|Compose|Run|Reach)$/,
    );
    expect(steps.map((s) => s.textContent)).toEqual([
      "1 · Configure",
      "2 · Compose",
      "3 · Run",
      "4 · Reach",
    ]);
  });

  it("renders every piece as its own card, including the pieces the flow adds", async () => {
    mockLists();
    renderAssembly();

    // Guards the regression this redesign could most easily cause: dropping a
    // navigable card while rearranging the layout.
    for (const title of [
      "API key",
      "Model card",
      "Environment",
      "Keys (Vault)",
      "Skills",
      "Connections (MCP)",
      "Agent",
      "Session",
      "Sandbox",
      "Channels",
      "Publications",
    ]) {
      expect(await screen.findByText(title)).toBeInTheDocument();
    }
  });

  it("shows live instance names as badges once resources exist", async () => {
    mockLists({
      "/v1/agents": [{ id: "agent_1", name: "Support bot" }],
      "/v1/api_keys": [{ id: "key_1", name: "CI key" }],
    });
    renderAssembly();

    expect(await screen.findByText("Support bot")).toBeInTheDocument();
    expect(await screen.findByText("CI key")).toBeInTheDocument();
  });

  it("counts only Configure + Compose toward the required-step tally", async () => {
    // An agent exists but there's no model card / environment, so exactly one
    // of the two required steps is done. Reach/Run must not inflate this.
    mockLists({ "/v1/agents": [{ id: "agent_1", name: "Support bot" }] });
    renderAssembly();

    expect(
      await screen.findByText("1 of 2 required steps complete"),
    ).toBeInTheDocument();
  });

  it("describes the Sandbox by the providers its environments actually use", async () => {
    mockLists({
      "/v1/environments": [
        { id: "env_1", name: "default", status: "ready", config: {} },
      ],
    });
    renderAssembly();

    // config.{} → the "cloud" default → friendly provider label, surfaced as
    // the RUN step's description rather than a bare badge.
    await waitFor(() =>
      expect(screen.getByText(/^Runs on .+ — set by your environment\.$/)).toBeInTheDocument(),
    );
  });
});
