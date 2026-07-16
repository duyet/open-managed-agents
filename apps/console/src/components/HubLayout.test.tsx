import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { RouterProvider, createMemoryRouter } from "react-router";

import { HubLayout, type HubConfig } from "./HubLayout";

const CONFIG: HubConfig = {
  title: "Resources",
  description: "Environments, credentials, memory, skills, files, and model cards.",
  tabs: [
    { label: "Environments", path: "/environments" },
    { label: "Vaults", path: "/vaults" },
    { label: "Skills", path: "/skills" },
  ],
};

function renderAt(pathname: string) {
  const router = createMemoryRouter(
    [
      {
        element: <HubLayout {...CONFIG} />,
        children: [
          { path: "environments", element: <div>Environments page</div> },
          { path: "vaults", element: <div>Vaults page</div> },
          { path: "skills", element: <div>Skills page</div> },
        ],
      },
    ],
    { initialEntries: [pathname] },
  );
  return render(<RouterProvider router={router} />);
}

describe("<HubLayout />", () => {
  it("renders the header and one tab link per config entry", () => {
    renderAt("/environments");
    expect(screen.getByRole("heading", { name: "Resources" })).toBeInTheDocument();
    expect(
      screen.getByText(/Environments, credentials, memory/),
    ).toBeInTheDocument();
    for (const tab of CONFIG.tabs) {
      expect(screen.getByRole("link", { name: tab.label })).toBeInTheDocument();
    }
  });

  it("renders the active tab's child route", () => {
    renderAt("/vaults");
    expect(screen.getByText("Vaults page")).toBeInTheDocument();
  });

  it("marks the tab for the current route as active (aria-current)", () => {
    renderAt("/vaults");
    expect(screen.getByRole("link", { name: "Vaults" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      screen.getByRole("link", { name: "Environments" }),
    ).not.toHaveAttribute("aria-current");
  });

  it("keeps a tab active on its nested detail routes", () => {
    const router = createMemoryRouter(
      [
        {
          element: <HubLayout {...CONFIG} />,
          children: [
            {
              path: "environments",
              children: [
                { index: true, element: <div>list</div> },
                { path: ":id", element: <div>detail</div> },
              ],
            },
          ],
        },
      ],
      { initialEntries: ["/environments/env_123"] },
    );
    render(<RouterProvider router={router} />);
    expect(screen.getByText("detail")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Environments" }),
    ).toHaveAttribute("aria-current", "page");
  });
});
