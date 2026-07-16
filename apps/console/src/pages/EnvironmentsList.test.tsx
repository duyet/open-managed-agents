import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";
import { EnvironmentsList } from "./EnvironmentsList";

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <EnvironmentsList />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("<EnvironmentsList />", () => {
  it("opens the Add Environment dialog without crashing on the Instance Type select", async () => {
    server.use(
      http.get("/v1/environments", () => HttpResponse.json({ data: [] })),
      // Simulate a self-host response that also includes an empty-id entry —
      // the exact shape that previously crashed the page with "A
      // <Select.Item /> must have a value prop that is not an empty string."
      http.get("/v1/hosting_types", () =>
        HttpResponse.json({
          data: [
            { id: "", label: "Legacy" },
            { id: "cloud", label: "Cloudflare Sandbox" },
          ],
        }),
      ),
    );
    renderPage();

    await waitFor(() => expect(screen.getByText("No environments yet")).toBeInTheDocument());

    const addButtons = screen.getAllByRole("button", { name: "+ Add environment" });
    await userEvent.click(addButtons[0]);

    // The dialog renders (proves the Select.Item empty-value crash didn't
    // white-screen the page) and the "Provider default" sentinel option
    // is visible.
    await waitFor(() => expect(screen.getByText("Add Environment")).toBeInTheDocument());
    expect(screen.getByText("Provider default")).toBeInTheDocument();
  });

  // Issue #182 — a failed list fetch must render a distinct error state
  // with a Retry action, never the "Nothing here yet" empty-state copy.
  it("shows an error state with Retry instead of the empty state when the fetch fails", async () => {
    server.use(
      http.get("/v1/environments", () => HttpResponse.json({ error: "Internal error" }, { status: 500 })),
      http.get("/v1/hosting_types", () => HttpResponse.json({ data: [] })),
    );
    renderPage();

    await waitFor(() =>
      expect(screen.getByText("Couldn't load environments")).toBeInTheDocument(),
    );
    expect(screen.getByText("Internal error")).toBeInTheDocument();
    expect(screen.queryByText("No environments yet")).not.toBeInTheDocument();

    const retryButton = screen.getByRole("button", { name: "Retry" });

    // Recovery: once the endpoint is healthy again, Retry re-fires the
    // fetch and the error state is replaced by the normal empty state.
    server.use(http.get("/v1/environments", () => HttpResponse.json({ data: [] })));
    await userEvent.click(retryButton);

    await waitFor(() => expect(screen.getByText("No environments yet")).toBeInTheDocument());
    expect(screen.queryByText("Couldn't load environments")).not.toBeInTheDocument();
  });
});
