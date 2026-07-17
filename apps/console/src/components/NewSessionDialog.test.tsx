import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";
import { NewSessionDialog } from "./NewSessionDialog";

function renderDialog(props: Partial<Parameters<typeof NewSessionDialog>[0]> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onCreated = props.onCreated ?? (() => {});
  return {
    onCreated,
    ...render(
      <QueryClientProvider client={queryClient}>
        <NewSessionDialog
          open
          onClose={() => {}}
          agentId="agt_1"
          isLocalRuntime={false}
          onCreated={onCreated}
          {...props}
        />
      </QueryClientProvider>,
    ),
  };
}

describe("<NewSessionDialog />", () => {
  it("preselects the tenant's single environment and includes it in the create body, plus an optional initial message", async () => {
    server.use(
      http.get("/v1/environments", () =>
        HttpResponse.json({ data: [{ id: "env_1", name: "Default" }] }),
      ),
      http.get("/v1/environments/env_1", () =>
        HttpResponse.json({ id: "env_1", name: "Default" }),
      ),
    );
    let createBody: unknown = null;
    let eventsBody: unknown = null;
    server.use(
      http.post("/v1/sessions", async ({ request }) => {
        createBody = await request.json();
        return HttpResponse.json({ id: "sess_1" });
      }),
      http.post("/v1/sessions/sess_1/events", async ({ request }) => {
        eventsBody = await request.json();
        return HttpResponse.json({ ok: true });
      }),
    );

    let created: string | null = null;
    renderDialog({ onCreated: (id) => { created = id; } });

    // Single environment is preselected — no manual pick needed.
    await waitFor(() => expect(screen.getByText(/Default/)).toBeInTheDocument());

    await userEvent.type(
      screen.getByPlaceholderText(/what should this session do/i),
      "Get started",
    );
    await userEvent.click(screen.getByRole("button", { name: "Create session" }));

    await waitFor(() =>
      expect(createBody).toEqual({ agent: "agt_1", environment_id: "env_1" }),
    );
    await waitFor(() =>
      expect(eventsBody).toEqual({
        events: [{ type: "user.message", content: [{ type: "text", text: "Get started" }] }],
      }),
    );
    await waitFor(() => expect(created).toBe("sess_1"));
  });

  it("shows a CTA instead of a picker when the tenant has no environments", async () => {
    server.use(http.get("/v1/environments", () => HttpResponse.json({ data: [] })));

    renderDialog();

    await waitFor(() =>
      expect(screen.getByText(/create an environment/i)).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Create session" })).toBeDisabled();
  });

  it("skips the environment step entirely for local-runtime agents", async () => {
    server.use(
      // Fetched by useDefaultEnvironment regardless of isLocalRuntime, but
      // never surfaced in the UI or sent on create for a local-runtime agent.
      http.get("/v1/environments", () => HttpResponse.json({ data: [] })),
      http.post("/v1/sessions", async ({ request }) => {
        const body = await request.json();
        expect(body).toEqual({ agent: "agt_1" });
        return HttpResponse.json({ id: "sess_1" });
      }),
    );

    let created: string | null = null;
    renderDialog({ isLocalRuntime: true, onCreated: (id) => { created = id; } });

    expect(screen.queryByText(/environment/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Create session" }));
    await waitFor(() => expect(created).toBe("sess_1"));
  });
});
