import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { FilterBar } from "./FilterBar";
import { FilterChip } from "./FilterChip";

const STATUS_OPTIONS = [
  { value: "any", label: "All" },
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
];

describe("<FilterBar />", () => {
  it("renders the common status + created facets", () => {
    render(
      <FilterBar
        status={{ value: "any", onChange: () => {}, options: STATUS_OPTIONS }}
        created={{ value: {}, onChange: () => {} }}
      />,
    );
    expect(screen.getByRole("button", { name: /Status/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Created/ })).toBeInTheDocument();
  });

  it("renders extra children ahead of the common facets", () => {
    render(
      <FilterBar
        status={{ value: "any", onChange: () => {}, options: STATUS_OPTIONS }}
      >
        <FilterChip label="Version" active={false}>
          <span>version-body</span>
        </FilterChip>
      </FilterBar>,
    );
    const buttons = screen.getAllByRole("button");
    // Children lead the row: Version chip comes before Status.
    expect(buttons[0]).toHaveTextContent("Version");
    expect(
      buttons.some((b) => b.textContent?.includes("Status")),
    ).toBe(true);
  });

  it("shows the selected label and clears via the chip's X", async () => {
    const onChange = vi.fn();
    render(
      <FilterBar
        status={{ value: "active", onChange, options: STATUS_OPTIONS }}
      />,
    );
    // Active chip renders its resolved display label.
    expect(screen.getByText("Active")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: /Clear Status filter/ }),
    );
    expect(onChange).toHaveBeenCalledWith("any");
  });

  it("opens the status popover and selects an option", async () => {
    const onChange = vi.fn();
    render(
      <FilterBar
        status={{ value: "any", onChange, options: STATUS_OPTIONS }}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Status/ }));
    await waitFor(() =>
      expect(screen.getByText("Archived")).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByText("Archived"));
    expect(onChange).toHaveBeenCalledWith("archived");
  });
});
