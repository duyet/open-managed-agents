import { describe, expect, it } from "vitest";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EnvVarsEditor, type EnvVarRow } from "./EnvVarsEditor";

function Harness({ initial = [] as EnvVarRow[] }) {
  const [rows, setRows] = useState<EnvVarRow[]>(initial);
  return (
    <>
      <EnvVarsEditor rows={rows} setRows={setRows} />
      <output data-testid="rows">{JSON.stringify(rows)}</output>
    </>
  );
}

describe("<EnvVarsEditor />", () => {
  it("parses a pasted .env block into rows (comments, export, quotes)", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const textarea = screen.getByLabelText(/Paste a/i);
    await user.click(textarea);
    // Paste avoids userEvent parsing `{` etc. in the placeholder-like content.
    await user.paste("# comment\nexport FOO=bar\nTOKEN=\"secret value\"\n");
    await user.click(screen.getByRole("button", { name: /Parse into rows/i }));

    const rows = JSON.parse(screen.getByTestId("rows").textContent!) as EnvVarRow[];
    expect(rows).toEqual([
      { name: "FOO", value: "bar", sensitive: false, hasStoredSecret: false },
      { name: "TOKEN", value: "secret value", sensitive: false, hasStoredSecret: false },
    ]);
  });

  it("masks a sensitive value and reveals it on demand", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={[{ name: "API_KEY", value: "hunter2", sensitive: true, hasStoredSecret: false }]}
      />,
    );

    const valueInput = screen.getByLabelText("Variable value") as HTMLInputElement;
    expect(valueInput.type).toBe("password");
    await user.click(screen.getByRole("button", { name: /Toggle value visibility/i }));
    expect((screen.getByLabelText("Variable value") as HTMLInputElement).type).toBe("text");
  });

  it("merges pasted keys over an existing row of the same name", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={[{ name: "FOO", value: "old", sensitive: true, hasStoredSecret: true }]}
      />,
    );
    const textarea = screen.getByLabelText(/Paste a/i);
    await user.click(textarea);
    await user.paste("FOO=new\nBAR=baz\n");
    await user.click(screen.getByRole("button", { name: /Parse into rows/i }));

    const rows = JSON.parse(screen.getByTestId("rows").textContent!) as EnvVarRow[];
    // FOO keeps its sensitive flag, value updated; BAR appended non-sensitive.
    expect(rows).toEqual([
      { name: "FOO", value: "new", sensitive: true, hasStoredSecret: true },
      { name: "BAR", value: "baz", sensitive: false, hasStoredSecret: false },
    ]);
  });
});
