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
  /** 2-3 concrete facts, rendered as a bullet list. */
  points?: string[];
  /** Mini flow diagram rendered above the points. */
  flow?: FlowItem[];
}

// ── Mini flow diagram ────────────────────────────────────────────────────
// Theme-token styled boxes joined by arrows — a consistent little visual
// grammar for every dialog without an SVG library. `hero` tints the box.

type FlowItem = { label: string; hero?: boolean; stack?: string[] };

function FlowDiagram({ items }: { items: FlowItem[] }) {
  return (
    <div className="my-3 flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-bg-surface/50 px-3 py-3" aria-hidden="true">
      {items.map((it, i) => (
        <span key={it.label} className="flex items-center gap-1.5">
          {i > 0 && <span className="text-fg-subtle">→</span>}
          {it.stack ? (
            <span className="flex flex-col gap-1">
              {it.stack.map((l) => (
                <span key={l} className="rounded border border-border bg-bg px-2 py-0.5 font-mono text-[11px] text-fg-muted">
                  {l}
                </span>
              ))}
            </span>
          ) : (
            <span
              className={
                it.hero
                  ? "rounded border border-brand/50 bg-brand/10 px-2 py-1 font-mono text-[11px] font-semibold text-brand"
                  : "rounded border border-border bg-bg px-2 py-1 font-mono text-[11px] text-fg"
              }
            >
              {it.label}
            </span>
          )}
        </span>
      ))}
    </div>
  );
}

// Monochrome sandbox-provider ids, same set as the landing page's fleet band
// and console's ProviderMark — rendered via the package's avatar-group.
const sandboxProviderIds = ["cloudflare", "kubernetes", "openshell", "e2b", "daytona", "docker-compose", "subprocess"];

export default function HowItFits() {
  const [dialog, setDialog] = useState<DialogContent | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const open = (title: string, desc: string, extra?: Pick<DialogContent, "points" | "flow">) => {
    setDialog({ title, desc, ...extra });
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
              {
                flow: [
                  { stack: ["oma CLI", "SDK / REST"] },
                  { label: "x-api-key", hero: true },
                  { label: "your OMA instance" },
                ],
                points: [
                  "One key authenticates the CLI, SDKs, and raw REST calls.",
                  "Scoped to your tenant — rotate or revoke per key.",
                ],
              },
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
              {
                flow: [
                  { label: "agent" },
                  { label: "model handle", hero: true },
                  { stack: ["provider", "api key", "base_url"] },
                ],
                points: [
                  "Anthropic, any OpenAI-compatible gateway, or your own endpoint.",
                  "Swap providers by editing the card — agent config never changes.",
                  "Mark one card as default for new agents.",
                ],
              },
            ),
        },
      ],
    },
    {
      number: "2",
      name: "Compose",
      wide: true,
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
              {
                flow: [
                  { stack: ["model", "skills", "mcp"] },
                  { label: "agent", hero: true },
                  { label: "session per conversation" },
                ],
                points: [
                  "A versioned configuration — every update creates a new version.",
                  "Stateless by itself; sessions bind to a specific version.",
                  "Can delegate to other agents (callable_agents), in parallel.",
                ],
              },
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
              {
                flow: [
                  { label: "SKILL.md + files" },
                  { label: "mounted in sandbox", hero: true },
                  { label: "injected into system prompt" },
                ],
                points: [
                  "Write once, attach to any number of agents.",
                  "Ships prompt fragments and supporting files together.",
                ],
              },
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
                {
                flow: [
                  { label: "/mnt/memory/<name>", hero: true },
                  { label: "ordinary file tools" },
                  { label: "survives across sessions" },
                ],
                points: [
                  "No bespoke memory tools — the agent just reads and writes files.",
                  "Every mutation is versioned: 30-day history, rollback, redaction.",
                ],
              },
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
                {
                flow: [
                  { label: "upload once" },
                  { label: "mount path you choose", hero: true },
                  { label: "any session sandbox" },
                ],
                points: [
                  "Datasets, configs, reference documents.",
                  "Attached to sessions at runtime — no re-upload per session.",
                ],
              },
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
                {
                flow: [
                  { stack: ["provider", "packages", "networking"] },
                  { label: "environment", hero: true },
                  { label: "sandbox per session" },
                ],
                points: [
                  "Cloudflare, Kubernetes, OpenShell, E2B, Daytona, Docker, your own machine.",
                  "pip / npm / apt / cargo preinstalls, allow-listed networking.",
                  "Reusable across agents and sessions.",
                ],
              },
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
                {
                flow: [
                  { label: "sandbox request" },
                  { label: "outbound proxy + auth", hero: true },
                  { label: "api.github.com" },
                ],
                points: [
                  "The proxy injects the right credential by URL match.",
                  "Raw tokens never enter the sandbox the agent controls.",
                  "Static bearer, OAuth (auto-refresh), and CLI-tool credentials.",
                ],
              },
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
              {
                flow: [
                  { stack: ["agent", "env", "vaults"] },
                  { label: "session", hero: true },
                  { label: "append-only event log" },
                ],
                points: [
                  "Streamed over SSE; resumable after crashes.",
                  "Pausable — snapshot the workspace, stop paying for idle compute.",
                  "Events are durably written before being broadcast.",
                ],
              },
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
              {
                flow: [
                  { label: "session" },
                  { label: "sandbox", hero: true },
                  { stack: ["bash + files", "browsers", "your code"] },
                ],
                points: [
                  "An isolated container or micro-VM per session.",
                  "Provider set by the environment — same agent, any substrate.",
                ],
              },
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
              {
                flow: [
                  { stack: ["Telegram", "Slack", "GitHub"] },
                  { label: "session turn", hero: true },
                  { label: "reply flows back" },
                ],
                points: [
                  "Each incoming message becomes a session turn.",
                  "GitHub issues/PRs, Slack threads, Telegram chats.",
                ],
              },
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
              {
                flow: [
                  { label: "agent" },
                  { label: "/p/<slug>", hero: true },
                  { stack: ["chat page", "embed widget", "QR / share"] },
                ],
                points: [
                  "Guest access — end users need no OMA account.",
                  "Optional per-message or per-token billing via Stripe credits.",
                ],
              },
            ),
        },
      ],
    },
  ];

  return (
    <div aria-label="How it fits together">
      <FitDiagram
        steps={steps}
        collapsible
        formula={[
          { lhs: "agent", parts: ["model", "skills", "mcp"] },
          { lhs: "session", parts: ["agent", "env", "vaults"] },
        ]}
      />

      {/* Native <dialog> — ESC and backdrop click close it for free. */}
      <dialog
        ref={dialogRef}
        aria-labelledby="fits-dialog-title"
        className="fixed inset-0 m-auto h-fit max-h-[calc(100dvh-3rem)] w-[calc(100vw-2.5rem)] max-w-lg overflow-y-auto rounded-[10px] border border-border bg-bg p-0 text-fg backdrop:bg-bg/60 backdrop:backdrop-blur-[2px]"
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
          {dialog?.flow && <FlowDiagram items={dialog.flow} />}
          {dialog?.points && (
            <ul className="mt-2 space-y-1.5">
              {dialog.points.map((pt) => (
                <li key={pt} className="flex gap-2 text-[0.8rem] leading-relaxed text-fg-muted">
                  <span className="mt-[1px] text-brand" aria-hidden="true">
                    ›
                  </span>
                  {pt}
                </li>
              ))}
            </ul>
          )}
        </div>
      </dialog>
    </div>
  );
}
