import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";
import { AgentBuilder } from "./AgentBuilder";

// Issue #183 — the "New Agent" wizard used to fabricate MCP server URLs
// from a string template (e.g. `https://mcp.api.githubcopilot.com/mcp` for
// GitHub — the wrong host) and hand-rolled its own /v1/agents body instead
// of the standard create flow's payload builder. These tests assert the
// wizard now (a) sources integrations from the same real, curated
// MCP_REGISTRY the standard create/edit flow uses instead of guessing a
// host, and (b) submits the exact same payload shape `formToConfig`
// (AgentFormDialog.tsx) produces.

function mockAuxFetches() {
  server.use(
    http.get("/v1/skills", () => HttpResponse.json({ data: [] })),
    http.get("/v1/model_cards", () => HttpResponse.json({ data: [] })),
    http.get("/v1/environments", () =>
      HttpResponse.json({
        data: [{ id: "env_1", name: "Default", config: { type: "cloud" } }],
      }),
    ),
  );
}

function renderWizard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AgentBuilder />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Drives the wizard from step 0 through step 4 (Integrations), filling in
 *  the two required fields (name, system prompt) and skipping Tools/Skills. */
async function advanceToIntegrationsStep() {
  const nameInput = await screen.findByPlaceholderText("My agent");
  await userEvent.type(nameInput, "Test Agent");
  await userEvent.click(screen.getByRole("button", { name: "Next →" }));

  const systemInput = await screen.findByPlaceholderText("You are a...");
  await userEvent.type(systemInput, "You are a test agent.");
  await userEvent.click(screen.getByRole("button", { name: "Next →" })); // → Tools
  await userEvent.click(screen.getByRole("button", { name: "Next →" })); // → Skills
  await userEvent.click(screen.getByRole("button", { name: "Next →" })); // → Integrations
}

describe("<AgentBuilder />", () => {
  it("submits a payload matching the standard create flow's shape (formToConfig), with a real curated URL for a picked integration", async () => {
    mockAuxFetches();
    let capturedBody: Record<string, unknown> | null = null;
    server.use(
      http.post("/v1/agents", async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ id: "agent_test123" });
      }),
    );

    renderWizard();
    await advanceToIntegrationsStep();

    // Pick "GitHub" from the real MCP_REGISTRY picker (same one the
    // standard create/edit flow's McpTab uses) rather than typing a URL.
    await userEvent.click(screen.getByRole("button", { name: "+ Pick known" }));
    await userEvent.click(await screen.findByText("GitHub"));

    await userEvent.click(screen.getByRole("button", { name: "Next →" })); // → Summary
    await userEvent.click(screen.getByRole("button", { name: "Create Agent" }));

    await waitFor(() => expect(capturedBody).not.toBeNull());
    const body = capturedBody as Record<string, unknown>;

    expect(body.name).toBe("Test Agent");
    expect(body.model).toBe("claude-sonnet-4-6");
    expect(body.system).toBe("You are a test agent.");
    // Never sent when blank — formToConfig omits falsy fields, unlike the
    // old wizard which always sent description as (possibly empty) string.
    expect(body.description).toBeUndefined();

    // Tools shape must match buildToolsField's output exactly: the builtin
    // toolset with only the one override that differs from the default
    // (web_search unchecked by default — not a hand-rolled "all 8 tools"
    // configs array), plus the mcp_toolset entry buildToolsField derives
    // from mcp_servers — wiring the old forked wizard never produced.
    expect(body.tools).toEqual([
      {
        type: "agent_toolset_20260401",
        default_config: { enabled: true, permission_policy: { type: "always_allow" } },
        configs: [{ name: "web_search", enabled: false }],
      },
      {
        type: "mcp_toolset",
        mcp_server_name: "github",
        default_config: { permission_policy: { type: "always_allow" } },
      },
    ]);

    // The picked integration must carry the REAL curated registry URL.
    expect(body.mcp_servers).toEqual([
      { name: "github", type: "url", url: "https://api.githubcopilot.com/mcp/" },
    ]);
    // mcp_servers[].name must pass the ^[a-zA-Z0-9_-]{1,40}$ validation
    // added in PR #221.
    expect(
      ((body.mcp_servers as Array<{ name: string }>)[0]).name,
    ).toMatch(/^[a-zA-Z0-9_-]{1,40}$/);

    // Never the old fabricated hosts for any service.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("mcp.api.githubcopilot.com");
    expect(raw).not.toContain(".app/mcp");
    expect(raw).not.toContain("mcp.slack.app");
  });

  it("omits mcp_servers entirely when no integration is picked — never fabricates one", async () => {
    mockAuxFetches();
    let capturedBody: Record<string, unknown> | null = null;
    server.use(
      http.post("/v1/agents", async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ id: "agent_test456" });
      }),
    );

    renderWizard();
    await advanceToIntegrationsStep();

    // Deliberately skip adding any integration.
    await userEvent.click(screen.getByRole("button", { name: "Next →" })); // → Summary
    await userEvent.click(screen.getByRole("button", { name: "Create Agent" }));

    await waitFor(() => expect(capturedBody).not.toBeNull());
    const body = capturedBody as Record<string, unknown>;
    expect(body.mcp_servers).toBeUndefined();
  });

  it("shows the Runtime summary with harness + environment provider/image", async () => {
    mockAuxFetches();
    renderWizard();
    await advanceToIntegrationsStep();
    await userEvent.click(screen.getByRole("button", { name: "Next →" })); // → Summary

    expect(await screen.findByText("Standard")).toBeInTheDocument();
    expect(screen.getByText("Default")).toBeInTheDocument();
    expect(screen.getByText("ghcr.io/duyet/sandbox-base:latest")).toBeInTheDocument();
  });

  it("only offers the built-in Anthropic models when no model card is configured", async () => {
    mockAuxFetches();
    renderWizard();

    await screen.findByPlaceholderText("My agent");
    expect(screen.getByRole("option", { name: "Claude Sonnet 4-6" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Claude Haiku 4-5" })).toBeInTheDocument();
    // No hardcoded, unguarded non-Anthropic ids (issue #183 evidence: the
    // old wizard offered gpt-4o/gpt-4o-mini with no model-card wiring).
    expect(screen.queryByRole("option", { name: /gpt-4o/i })).not.toBeInTheDocument();
  });

  it("gates non-default models on a real, existing model card", async () => {
    server.use(
      http.get("/v1/skills", () => HttpResponse.json({ data: [] })),
      http.get("/v1/model_cards", () =>
        HttpResponse.json({
          data: [
            {
              id: "mc_1",
              model_id: "gpt-4o-via-proxy",
              model: "gpt-4o",
              provider: "oai-compatible",
              is_default: false,
              created_at: "2026-01-01T00:00:00.000Z",
            },
          ],
        }),
      ),
    );

    renderWizard();

    // The card's model_id shows up as an option only because a real card
    // backs it — not a hardcoded guess.
    await waitFor(() =>
      expect(
        screen.getByRole("option", { name: "gpt-4o-via-proxy (gpt-4o)" }),
      ).toBeInTheDocument(),
    );
  });
});
