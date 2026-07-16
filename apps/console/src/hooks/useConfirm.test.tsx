import { useState } from "react";
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ConfirmProvider, useConfirm } from "./useConfirm";

/** Minimal harness: a trigger button calls confirm() with fixed options and
 *  renders the resolved boolean so tests can assert on it without reaching
 *  into internals. */
function Harness() {
  const confirm = useConfirm();
  const [result, setResult] = useState("unset");

  const ask = async () => {
    const ok = await confirm({
      title: "Delete this thing?",
      description: "This can't be undone.",
      confirmLabel: "Delete",
      destructive: true,
    });
    setResult(String(ok));
  };

  return (
    <>
      <button onClick={ask}>Ask</button>
      <p>result: {result}</p>
    </>
  );
}

function renderHarness() {
  return render(
    <ConfirmProvider>
      <Harness />
    </ConfirmProvider>,
  );
}

describe("useConfirm / ConfirmProvider", () => {
  it("shows the danger-styled dialog and resolves true when the destructive action is confirmed", async () => {
    const user = userEvent.setup();
    renderHarness();

    await user.click(screen.getByRole("button", { name: "Ask" }));

    expect(screen.getByText("Delete this thing?")).toBeInTheDocument();
    expect(screen.getByText("This can't be undone.")).toBeInTheDocument();
    const deleteButton = screen.getByRole("button", { name: "Delete" });
    expect(deleteButton).toHaveAttribute("data-variant", "destructive");

    await user.click(deleteButton);

    await waitFor(() => expect(screen.getByText("result: true")).toBeInTheDocument());
    expect(screen.queryByText("Delete this thing?")).not.toBeInTheDocument();
  });

  it("resolves false and dismisses the dialog when Cancel is clicked", async () => {
    const user = userEvent.setup();
    renderHarness();

    await user.click(screen.getByRole("button", { name: "Ask" }));
    expect(screen.getByText("Delete this thing?")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.getByText("result: false")).toBeInTheDocument());
    expect(screen.queryByText("Delete this thing?")).not.toBeInTheDocument();
  });

  it("resolves false on Escape — same dismissal path as Cancel", async () => {
    const user = userEvent.setup();
    renderHarness();

    await user.click(screen.getByRole("button", { name: "Ask" }));
    expect(screen.getByText("Delete this thing?")).toBeInTheDocument();

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.getByText("result: false")).toBeInTheDocument());
  });

  it("falls back to Confirm/Cancel labels and the default (non-destructive) button style", async () => {
    function DefaultHarness() {
      const confirm = useConfirm();
      const [result, setResult] = useState("unset");
      return (
        <>
          <button onClick={async () => setResult(String(await confirm({ title: "Roll back?" })))}>
            Ask
          </button>
          <p>result: {result}</p>
        </>
      );
    }

    const user = userEvent.setup();
    render(
      <ConfirmProvider>
        <DefaultHarness />
      </ConfirmProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Ask" }));
    const confirmButton = screen.getByRole("button", { name: "Confirm" });
    expect(confirmButton).toHaveAttribute("data-variant", "default");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();

    await user.click(confirmButton);
    await waitFor(() => expect(screen.getByText("result: true")).toBeInTheDocument());
  });
});
