import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";

import { server } from "../../mocks/server";
import { CreateScheduleDialog } from "./CreateScheduleDialog";
import type { AgentRecord } from "../../types/agent";

const agent: AgentRecord = {
  id: "agent_1",
  name: "My Agent",
  model: "claude-new",
  version: 2,
  created_at: "2026-01-01T00:00:00Z",
};

function renderDialog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onCreated = vi.fn();
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <CreateScheduleDialog open onClose={onClose} agent={agent} onCreated={onCreated} />
    </QueryClientProvider>,
  );
  return { onCreated, onClose };
}

/** Pick the mocked environment via the custom Combobox placeholder. */
async function pickEnvironment(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByText("Select environment..."));
  await waitFor(() => expect(screen.getByText("Prod")).toBeInTheDocument());
  await user.click(screen.getByText("Prod"));
}

describe("<CreateScheduleDialog />", () => {
  it("submits a schedule with the right POST body", async () => {
    const user = userEvent.setup();
    let posted: Record<string, unknown> | undefined;
    server.use(
      http.get("/v1/environments", () =>
        HttpResponse.json({ data: [{ id: "env_1", name: "Prod" }] }),
      ),
      http.post("/v1/agents/agent_1/schedules", async ({ request }) => {
        posted = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ...posted, id: "sch_1" }, { status: 201 });
      }),
    );
    const { onCreated } = renderDialog();

    await user.type(
      screen.getByPlaceholderText("Post the weekly metrics digest to #general."),
      "Post the digest",
    );
    await pickEnvironment(user);
    await user.click(screen.getByRole("button", { name: "Create schedule" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(posted).toMatchObject({
      cron_expression: "0 9 * * 1",
      timezone: "UTC",
      environment_id: "env_1",
      input: "Post the digest",
      max_sessions: 1,
    });
  });

  it("keeps the create button disabled until required fields are filled", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/v1/environments", () =>
        HttpResponse.json({ data: [{ id: "env_1", name: "Prod" }] }),
      ),
    );
    renderDialog();

    // cron is prefilled, but input + environment are still empty.
    const createBtn = screen.getByRole("button", { name: "Create schedule" });
    expect(createBtn).toBeDisabled();

    await user.type(
      screen.getByPlaceholderText("Post the weekly metrics digest to #general."),
      "Do the thing",
    );
    await pickEnvironment(user);

    await waitFor(() => expect(createBtn).not.toBeDisabled());
  });
});
