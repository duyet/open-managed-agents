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
});
