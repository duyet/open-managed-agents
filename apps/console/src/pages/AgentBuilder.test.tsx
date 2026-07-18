import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";
import { AgentBuilder } from "./AgentBuilder";

// The full-page `/agents/new` route now renders the exact same
// `AgentCreateForm` the New Agent dialog uses — one shared implementation.
// These tests drive that page: template picker first, then the tabbed form
// with the runtime-first cloud/local flow, and assert the submitted payload
// matches the shared `formToConfig`/`buildToolsField` shape.

function mockAuxFetches() {
  server.use(
    http.get("/v1/agents", () => HttpResponse.json({ data: [] })),
    http.get("/v1/skills", () => HttpResponse.json({ data: [] })),
    http.get("/v1/model_cards", () => HttpResponse.json({ data: [] })),
    http.get("/v1/runtimes", () => HttpResponse.json({ runtimes: [] })),
  );
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AgentBuilder />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Template step → pick "Blank agent config" → land on the Basic tab. */
async function pickBlankTemplate() {
  await userEvent.click(await screen.findByText("Blank agent config"));
}

describe("<AgentBuilder /> (shared create form, page variant)", () => {
  it("shows the template picker first", async () => {
    mockAuxFetches();
    renderPage();
    expect(await screen.findByText("Blank agent config")).toBeInTheDocument();
    // A curated template beyond blank is offered too.
    expect(screen.getByText("Deep researcher")).toBeInTheDocument();
  });

  it("orders the Basic fields identity-first (name, description, system) then the runtime choice", async () => {
    mockAuxFetches();
    renderPage();
    await pickBlankTemplate();

    const name = await screen.findByPlaceholderText("Coding Assistant");
    const description = screen.getByPlaceholderText(
      "A coding assistant that writes clean code...",
    );
    const system = screen.getByPlaceholderText("You are a helpful assistant...");
    // DOM order must be name → description → system → runtime.
    const pos = (el: Element) =>
      // eslint-disable-next-line no-bitwise
      name.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING;
    expect(pos(description)).toBeTruthy();
    expect(pos(system)).toBeTruthy();
    // Runtime section is present and defaults to Cloud.
    expect(screen.getByRole("radio", { name: /Cloud/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("switching to Local with no runtimes shows the connect-a-machine hint", async () => {
    mockAuxFetches();
    renderPage();
    await pickBlankTemplate();
    await screen.findByPlaceholderText("Coding Assistant");

    await userEvent.click(screen.getByRole("radio", { name: /Local/ }));
    expect(
      await screen.findByText(/No runtimes registered/),
    ).toBeInTheDocument();
  });

  it("submits a payload matching the shared formToConfig shape, with a real curated URL for a picked integration", async () => {
    mockAuxFetches();
    let capturedBody: Record<string, unknown> | null = null;
    server.use(
      http.post("/v1/agents", async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ id: "agent_test123" });
      }),
    );

    renderPage();
    await pickBlankTemplate();

    await userEvent.type(
      await screen.findByPlaceholderText("Coding Assistant"),
      "Test Agent",
    );
    await userEvent.type(
      screen.getByPlaceholderText("You are a helpful assistant..."),
      " Extra instructions.",
    );

    // MCP Servers tab → pick GitHub from the real curated registry.
    await userEvent.click(screen.getByRole("tab", { name: /MCP Servers/ }));
    await userEvent.click(screen.getByRole("button", { name: "+ Pick known" }));
    await userEvent.click(await screen.findByText("GitHub"));

    await userEvent.click(screen.getByRole("button", { name: "Create Agent" }));

    await waitFor(() => expect(capturedBody).not.toBeNull());
    const body = capturedBody as unknown as Record<string, unknown>;

    expect(body.name).toBe("Test Agent");

    // buildToolsField's exact output: the builtin toolset (no per-tool
    // overrides on a fresh form) plus the derived mcp_toolset entry.
    expect(body.tools).toEqual([
      {
        type: "agent_toolset_20260401",
        default_config: { enabled: true, permission_policy: { type: "always_allow" } },
      },
      {
        type: "mcp_toolset",
        mcp_server_name: "github",
        default_config: { permission_policy: { type: "always_allow" } },
      },
    ]);

    // The picked integration carries the REAL curated registry URL — never a
    // fabricated host.
    expect(body.mcp_servers).toEqual([
      { name: "github", type: "url", url: "https://api.githubcopilot.com/mcp/" },
    ]);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("mcp.api.githubcopilot.com");
    expect(raw).not.toContain(".app/mcp");
  });

  it("pre-fills the system prompt from a curated template", async () => {
    mockAuxFetches();
    renderPage();
    await userEvent.click(await screen.findByText("Deep researcher"));

    const system = (await screen.findByPlaceholderText(
      "You are a helpful assistant...",
    )) as HTMLTextAreaElement;
    expect(system.value).toMatch(/research agent/i);
  });
});
