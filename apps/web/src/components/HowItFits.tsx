// Static mirror of the Console's "How it fits together" panel
// (apps/console/src/components/StackedAssembly.tsx), rendered through the
// shared @duyet/oma-fit-diagram package. Same visual grammar — numbered step
// columns, dashed type-cards with instance badges, the composition formula,
// flow pointers — but purely decorative: no links, no live data, example
// instances hard-coded. The click-to-describe <dialog> and the sandbox
// avatar-group live here (host-specific interaction); FitDiagram only knows
// about `onActivate` callbacks and `providerMarks` ids.
import { useRef, useState } from "react";
import { FitDiagram, type FitStep } from "@duyet/oma-fit-diagram";

interface DialogContent {
  title: string;
  desc: string;
}

// Monochrome sandbox-provider ids, same set as the landing page's fleet band
// and console's ProviderMark — rendered via the package's avatar-group.
const sandboxProviderIds = ["cloudflare", "kubernetes", "openshell", "e2b", "daytona", "docker-compose", "subprocess"];

export default function HowItFits() {
  const [dialog, setDialog] = useState<DialogContent | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const open = (title: string, desc: string) => {
    setDialog({ title, desc });
    dialogRef.current?.showModal();
  };

  const steps: FitStep[] = [
    {
      number: "1",
      name: "Configure",
      cards: [
        {
          key: "api-key",
          title: "API key",
          badges: ["cli"],
          onActivate: () =>
            open(
              "API key",
              "Authenticates the CLI and your programs against your OMA instance. Every REST call, SDK call, and `oma` CLI command presents one — scoped to your tenant.",
            ),
        },
        {
          key: "model",
          title: "Model card",
          badges: ["claude-sonnet-4-6"],
          onActivate: () =>
            open(
              "Model card",
              "The AI brain, made pluggable. A model card binds a model id to a provider and credentials — Anthropic, any OpenAI-compatible gateway, or your own endpoint. Agents reference it by handle, so swapping providers never touches agent config.",
            ),
        },
      ],
    },
    {
      number: "2",
      name: "Compose",
      wide: true,
      center: true,
      cards: [
        {
          key: "agent",
          title: "Agent",
          badges: ["support-bot"],
          hero: true,
          onActivate: () =>
            open(
              "Agent",
              "The thing you're building: agent = model + skills + mcp. A versioned configuration — system prompt, tools, skills, MCP servers, callable sub-agents. Stateless by itself; every conversation with it runs as a session.",
            ),
        },
        {
          key: "skills",
          title: "Skills",
          badges: ["xlsx", "pdf", "pptx"],
          onActivate: () =>
            open(
              "Skills",
              "Reusable know-how: prompt fragments and files mounted into the sandbox and injected into the system prompt. Write a skill once, attach it to any number of agents.",
            ),
        },
        [
          {
            key: "memory",
            title: "Memory",
            note: "Notes it keeps",
            dashed: true,
            onActivate: () =>
              open(
                "Memory",
                "Persistent memory stores, mounted into the sandbox at /mnt/memory/<name>. The agent reads and writes them with ordinary file tools, so knowledge survives across sessions — versioned, auditable, and rollback-able.",
              ),
          },
          {
            key: "files",
            title: "Files",
            note: "Data to mount",
            dashed: true,
            onActivate: () =>
              open(
                "Files",
                "Files you upload once and mount into any session's sandbox at a path you choose — datasets, configs, reference documents. Created once, attached to sessions at runtime.",
              ),
          },
        ],
      ],
    },
    {
      number: "3",
      name: "Run",
      chain: true,
      chainLabels: ["+ agent =", "runs inside"],
      cards: [
        [
          {
            key: "environment",
            title: "Environment",
            badges: ["cloudflare"],
            onActivate: () =>
              open(
                "Environment",
                "Defines the execution sandbox: which provider runs it (Cloudflare, Kubernetes, OpenShell, E2B, …), what packages are preinstalled, and what networking is allowed. Reusable across agents and sessions.",
              ),
          },
          {
            key: "vaults",
            title: "Keys (Vault)",
            badges: ["prod-secrets"],
            onActivate: () =>
              open(
                "Keys (Vault)",
                "Secrets the agent calls out with — API tokens, OAuth credentials. Injected by an outbound proxy at the network layer, so raw credentials never enter the sandbox the agent controls.",
              ),
          },
        ],
        {
          key: "session",
          title: "Session",
          note: "One conversation or task — streamed, resumable event log.",
          onActivate: () =>
            open(
              "Session",
              "One conversation or task: session = agent + env + vaults. An append-only, durably-stored event log — streamed over SSE, resumable after crashes, pausable to stop paying for idle compute.",
            ),
        },
        {
          key: "sandbox",
          title: "Sandbox",
          note: "Set by your environment.",
          providerMarks: sandboxProviderIds,
          onActivate: () =>
            open(
              "Sandbox",
              "The isolated container or micro-VM where the agent's tools actually execute — bash, files, browsers. Provisioned per session by whichever provider the environment selects: Cloudflare, Kubernetes, NVIDIA OpenShell, E2B, Daytona, Docker, and more.",
            ),
        },
      ],
    },
    {
      number: "4",
      name: "Reach",
      optional: true,
      cards: [
        {
          key: "channels",
          title: "Channels",
          note: "Telegram, Slack, GitHub",
          dashed: true,
          onActivate: () =>
            open(
              "Channels",
              "Wire the agent into where work already happens: Telegram chats, Slack workspaces, GitHub issues and PRs. Each message in becomes a session turn; replies flow back to the channel.",
            ),
        },
        {
          key: "publications",
          title: "Publications",
          note: "Public chat page or widget",
          dashed: true,
          onActivate: () =>
            open(
              "Publications",
              "Publish the agent as a consumer-facing bot: a hosted chat page, an embeddable widget, guest access, and optional per-message billing — no OMA account needed for end users.",
            ),
        },
      ],
    },
  ];

  return (
    <div aria-label="How it fits together">
      <FitDiagram
        steps={steps}
        formula={[
          { lhs: "agent", parts: ["model", "skills", "mcp"] },
          { lhs: "session", parts: ["agent", "env", "vaults"] },
        ]}
      />

      {/* Native <dialog> — ESC and backdrop click close it for free. */}
      <dialog
        ref={dialogRef}
        aria-labelledby="fits-dialog-title"
        className="fixed inset-0 m-auto h-fit max-h-[calc(100dvh-3rem)] w-[calc(100vw-2.5rem)] max-w-md overflow-y-auto rounded-[10px] border border-border bg-bg p-0 text-fg backdrop:bg-bg/60 backdrop:backdrop-blur-[2px]"
        onClick={(e) => {
          if (e.target === dialogRef.current) dialogRef.current?.close();
        }}
      >
        <div className="p-[1.1rem_1.25rem_1.25rem]">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h3 id="fits-dialog-title" className="text-base font-semibold tracking-tight">
              {dialog?.title}
            </h3>
            <button
              type="button"
              aria-label="Close"
              className="px-1 text-sm text-fg-subtle hover:text-fg"
              onClick={() => dialogRef.current?.close()}
            >
              ✕
            </button>
          </div>
          <p className="text-[0.85rem] leading-relaxed text-fg-muted">{dialog?.desc}</p>
        </div>
      </dialog>
    </div>
  );
}
