import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";

import { server } from "../mocks/server";
import {
  EnvironmentPicker,
  MemoryStoresPicker,
  VaultsPicker,
} from "./ResourcePicker";

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

describe("<EnvironmentPicker />", () => {
  it("loads options from /v1/environments and calls onChange on pick", async () => {
    server.use(
      http.get("/v1/environments", () =>
        HttpResponse.json({
          data: [
            { id: "env_alpha", name: "Alpha" },
            { id: "env_beta", name: "Beta" },
          ],
        }),
      ),
    );
    const onChange = vi.fn();
    renderWithClient(<EnvironmentPicker value="" onChange={onChange} />);

    // Label row: field name + same-tab Manage link.
    expect(screen.getByText("Environment")).toBeInTheDocument();
    const manage = screen.getByRole("link", { name: /Manage environments/ });
    expect(manage).toHaveAttribute("href", "/environments");
    expect(manage).not.toHaveAttribute("target", "_blank");

    // Open the combobox → options fetch → pick "Beta".
    await userEvent.click(screen.getByRole("combobox"));
    await waitFor(() => expect(screen.getByText("Beta")).toBeInTheDocument());
    await userEvent.click(screen.getByText("Beta"));

    expect(onChange).toHaveBeenCalledWith("env_beta");
  });

  it("renders (optional) tag and error message when provided", () => {
    renderWithClient(
      <EnvironmentPicker
        value=""
        onChange={() => {}}
        optional
        error="Select an environment"
      />,
    );
    expect(screen.getByText("(optional)")).toBeInTheDocument();
    expect(screen.getByText("Select an environment")).toBeInTheDocument();
  });
});

describe("<VaultsPicker />", () => {
  it("adds a vault id via the Add combobox and calls onChange", async () => {
    server.use(
      http.get("/v1/vaults", () =>
        HttpResponse.json({
          data: [
            { id: "vault_1", name: "Prod secrets" },
            { id: "vault_2", name: "Staging secrets" },
          ],
        }),
      ),
    );
    const onChange = vi.fn();
    renderWithClient(<VaultsPicker value={[]} onChange={onChange} />);

    const manage = screen.getByRole("link", { name: /Manage vaults/ });
    expect(manage).toHaveAttribute("href", "/vaults");

    await userEvent.click(screen.getByRole("combobox"));
    await waitFor(() =>
      expect(screen.getByText("Prod secrets")).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByText("Prod secrets"));

    expect(onChange).toHaveBeenCalledWith(["vault_1"]);
  });

  it("renders selected vault rows with a remove control", async () => {
    server.use(
      http.get("/v1/vaults", () => HttpResponse.json({ data: [] })),
      // Preset-id label resolution goes through GET /v1/vaults/:id — but the
      // multi-select falls back to the raw id when no label was captured, so
      // the id itself must be visible.
      http.get("/v1/vaults/:id", ({ params }) =>
        HttpResponse.json({ id: params.id, name: "Prod secrets" }),
      ),
    );
    const onChange = vi.fn();
    renderWithClient(<VaultsPicker value={["vault_1"]} onChange={onChange} />);

    // Selected row shows the id and a remove button.
    expect(screen.getByText("vault_1")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Remove/ }));
    expect(onChange).toHaveBeenCalledWith([]);
  });
});

describe("<MemoryStoresPicker />", () => {
  it("loads options from /v1/memory_stores and links to /memory", async () => {
    server.use(
      http.get("/v1/memory_stores", () =>
        HttpResponse.json({ data: [{ id: "ms_1", name: "Notes" }] }),
      ),
    );
    const onChange = vi.fn();
    renderWithClient(<MemoryStoresPicker value={[]} onChange={onChange} />);

    expect(screen.getByRole("link", { name: /Manage memory stores/ })).toHaveAttribute(
      "href",
      "/memory",
    );

    await userEvent.click(screen.getByRole("combobox"));
    await waitFor(() => expect(screen.getByText("Notes")).toBeInTheDocument());
    await userEvent.click(screen.getByText("Notes"));

    expect(onChange).toHaveBeenCalledWith(["ms_1"]);
  });
});
