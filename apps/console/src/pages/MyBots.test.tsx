import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";
import { MyBots } from "./MyBots";

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <MyBots />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function pub(overrides: Record<string, unknown> = {}) {
  return {
    id: "pub_1",
    agent_id: "agt_1",
    agent_version: 1,
    slug: "duyetbot",
    title: "Duyetbot",
    description: null,
    avatar_url: null,
    visibility: "public",
    status: "live",
    greeting: null,
    suggested_prompts: [],
    pricing_ref: null,
    rate_limit_ref: null,
    environment_id: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("<MyBots />", () => {
  it("shows an empty state when there are no publications", async () => {
    server.use(http.get("/v1/publications", () => HttpResponse.json({ data: [] })));
    renderPage();
    await waitFor(() => expect(screen.getByText(/No published bots yet/i)).toBeInTheDocument());
  });

  it("lists publications with their public link and status", async () => {
    server.use(http.get("/v1/publications", () => HttpResponse.json({ data: [pub()] })));
    renderPage();
    await waitFor(() => expect(screen.getByText("Duyetbot")).toBeInTheDocument());
    expect(screen.getByText("/p/duyetbot")).toBeInTheDocument();
    expect(screen.getByText("live")).toBeInTheDocument();
  });

  it("opens a Share panel with a QR code and embed snippet", async () => {
    server.use(http.get("/v1/publications", () => HttpResponse.json({ data: [pub()] })));
    renderPage();
    await waitFor(() => expect(screen.getByText("Duyetbot")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "Share" }));

    // QR renders as inline SVG; the embed snippet points at the widget script.
    await waitFor(() => expect(screen.getByText(/Share Duyetbot/)).toBeInTheDocument());
    const snippet = screen.getByDisplayValue(/widget\.js/);
    expect((snippet as HTMLTextAreaElement).value).toContain("/p/duyetbot/widget.js");
  });

  it("sums per-user conversation counts into the Conversations column (issue #237)", async () => {
    server.use(
      http.get("/v1/publications", () => HttpResponse.json({ data: [pub()] })),
      http.get("/v1/publications/pub_1/users", () =>
        HttpResponse.json({
          data: [
            { consumer_id: "c1", conversation_count: 3 },
            { consumer_id: "c2", conversation_count: 2 },
          ],
        }),
      ),
    );
    renderPage();
    await waitFor(() => expect(screen.getByText("Duyetbot")).toBeInTheDocument());
    expect(await screen.findByText("5")).toBeInTheDocument();
  });

  it("falls back to a dash if the conversation-count fetch fails, without breaking the row", async () => {
    server.use(
      http.get("/v1/publications", () => HttpResponse.json({ data: [pub()] })),
      http.get("/v1/publications/pub_1/users", () =>
        HttpResponse.json({ error: "Internal error" }, { status: 500 }),
      ),
    );
    renderPage();
    await waitFor(() => expect(screen.getByText("Duyetbot")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("—")).toBeInTheDocument());
  });

  it("opens the edit-publication dialog from the pencil icon, prefilled from the row (issue #237)", async () => {
    server.use(
      http.get("/v1/publications", () => HttpResponse.json({ data: [pub()] })),
      http.get("/v1/publications/pub_1/users", () => HttpResponse.json({ data: [] })),
    );
    renderPage();
    await waitFor(() => expect(screen.getByText("Duyetbot")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "Edit publication" }));

    await waitFor(() => expect(screen.getByText("Edit Duyetbot")).toBeInTheDocument());
    expect(screen.getByDisplayValue("duyetbot")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Duyetbot")).toBeInTheDocument();
  });
});
