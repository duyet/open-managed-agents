import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConnectModeChooser } from "./ConnectModeChooser";

describe("<ConnectModeChooser />", () => {
  it("renders both the managed and own-app paths", () => {
    render(
      <ConnectModeChooser
        provider="Slack"
        availability={true}
        onSelectManaged={() => {}}
        onSelectOwn={() => {}}
      />,
    );
    expect(screen.getByText("OMA managed app")).toBeInTheDocument();
    expect(screen.getByText("Your own app")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Connect" })).toHaveLength(2);
  });

  it("disables the managed path with a remediation note when unavailable", () => {
    render(
      <ConnectModeChooser
        provider="Linear"
        availability={false}
        onSelectManaged={() => {}}
        onSelectOwn={() => {}}
      />,
    );
    const buttons = screen.getAllByRole("button", { name: "Connect" });
    expect(buttons[0]).toBeDisabled();
    expect(buttons[1]).toBeEnabled();
    expect(
      screen.getByText(/Not configured on this deployment/i),
    ).toBeInTheDocument();
  });

  it("keeps the managed path enabled while availability is still loading", () => {
    render(
      <ConnectModeChooser
        provider="GitHub"
        availability={null}
        onSelectManaged={() => {}}
        onSelectOwn={() => {}}
      />,
    );
    const buttons = screen.getAllByRole("button", { name: "Connect" });
    expect(buttons[0]).toBeEnabled();
  });

  it("fires onSelectManaged / onSelectOwn from the matching card", async () => {
    const onSelectManaged = vi.fn();
    const onSelectOwn = vi.fn();
    render(
      <ConnectModeChooser
        provider="GitHub"
        availability={true}
        onSelectManaged={onSelectManaged}
        onSelectOwn={onSelectOwn}
      />,
    );
    const [managedBtn, ownBtn] = screen.getAllByRole("button", { name: "Connect" });
    await userEvent.click(managedBtn);
    expect(onSelectManaged).toHaveBeenCalledTimes(1);
    expect(onSelectOwn).not.toHaveBeenCalled();

    await userEvent.click(ownBtn);
    expect(onSelectOwn).toHaveBeenCalledTimes(1);
  });
});
