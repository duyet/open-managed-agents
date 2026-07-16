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
});
