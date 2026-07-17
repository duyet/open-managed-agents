// Static mirror of the Console's "How it fits together" panel
// (apps/console/src/components/StackedAssembly.tsx), rendered through the
// shared @duyet/oma-fit-diagram package. Same visual grammar — numbered step
// columns, dashed type-cards with instance badges, the composition formula,
// flow pointers — but purely decorative: no links, no live data, example
// instances hard-coded. The click-to-describe <dialog> and the sandbox
// avatar-group live here (host-specific interaction); FitDiagram only knows
// about `onActivate` callbacks and `providerMarks` ids.
import { useRef, useState } from "react";
import { FitDiagram, ProviderMark, type FitStep } from "@duyet/oma-fit-diagram";

interface DialogContent {
  title: string;
  desc: string;
  /** 2-3 concrete facts, rendered as a bullet list. */
  points?: string[];
  /** Mini flow diagram rendered above the points. */
  flow?: FlowItem[];
  /** Supported providers/integrations — logo tiles, each linking to setup docs. */
  resources?: DialogResource[];
  /** Related docs / blog links. */
  links?: { label: string; href: string }[];
}

interface DialogResource {
  /** ProviderMark id (sandbox providers) or a CHANNEL_MARKS key. */
  id: string;
  label: string;
  href: string;
}

const DOCS = "https://docs.oma.duyet.net";

// Channel logos (Simple Icons single-path marks) — ProviderMark only covers
// sandbox providers, so chat/issue-tracker marks live here.
const CHANNEL_MARKS: Record<string, string> = {
  github:
    "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
  slack:
    "M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z",
  telegram:
    "M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z",
  linear:
    "M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z",
};

// Brand colors for channel marks — GitHub stays currentColor (its black
// mark would vanish on dark backgrounds).
const CHANNEL_COLORS: Record<string, string> = {
  slack: "#E01E5A",
  telegram: "#26A5E4",
  linear: "#5E6AD2",
};

function ResourceMark({ id }: { id: string }) {
  const channel = CHANNEL_MARKS[id];
  if (channel) {
    return (
      <svg
        viewBox="0 0 24 24"
        className="size-4"
        fill="currentColor"
        style={CHANNEL_COLORS[id] ? { color: CHANNEL_COLORS[id] } : undefined}
        aria-hidden="true"
      >
        <path d={channel} />
      </svg>
    );
  }
  return <ProviderMark id={id} colored className="size-4" />;
}

/** Grid of supported providers/integrations — each tile links to its setup guide. */
function ResourceGrid({ items }: { items: DialogResource[] }) {
  return (
    <div className="mt-3 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
      {items.map((r) => (
        <a
          key={r.id + r.href}
          href={r.href}
          target="_blank"
          rel="noreferrer"
          className="group flex items-center gap-2 rounded-md border border-border bg-bg-surface/60 px-2.5 py-2 no-underline transition-colors hover:border-brand/60 hover:bg-bg-surface"
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border bg-bg text-fg-muted group-hover:text-brand">
            <ResourceMark id={r.id} />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[12px] font-medium text-fg">{r.label}</span>
            <span className="block text-[10px] text-fg-subtle group-hover:text-brand">setup →</span>
          </span>
        </a>
      ))}
    </div>
  );
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
                links: [
                  { label: "Quickstart", href: `${DOCS}/quickstart/` },
                  { label: "CLI & SDK", href: `${DOCS}/build/cli-sdk/` },
                  { label: "API reference", href: `${DOCS}/reference/api/` },
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
                links: [
                  { label: "Configuration reference", href: `${DOCS}/reference/configuration/` },
                  { label: "Claude Managed Agents vs OMA", href: "/blog/claude-managed-agents-vs-open-managed-agents/" },
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
                links: [
                  { label: "Core concepts", href: `${DOCS}/concepts/` },
                  { label: "How it works", href: `${DOCS}/how-it-works/` },
                  { label: "Migrating from Claude Managed Agents", href: "/blog/migrate-from-claude-managed-agents/" },
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
                links: [
                  { label: "Skills & tools guide", href: `${DOCS}/build/skills-and-tools/` },
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
                links: [
                  { label: "Core concepts", href: `${DOCS}/concepts/` },
                  { label: "Glossary", href: `${DOCS}/reference/glossary/` },
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
                links: [
                  { label: "Skills & tools guide", href: `${DOCS}/build/skills-and-tools/` },
                  { label: "API reference", href: `${DOCS}/reference/api/` },
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
                resources: [
                  { id: "cloudflare", label: "Cloudflare", href: `${DOCS}/deploy/cloudflare/` },
                  { id: "kubernetes", label: "Kubernetes", href: `${DOCS}/deploy/kubernetes/` },
                  { id: "docker-compose", label: "Docker", href: `${DOCS}/deploy/docker/` },
                ],
                links: [
                  { label: "Deploy overview", href: `${DOCS}/deploy/` },
                  { label: "Configuration reference", href: `${DOCS}/reference/configuration/` },
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
                links: [
                  { label: "Vault & MCP guide", href: `${DOCS}/build/vault-and-mcp/` },
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
                links: [
                  { label: "How it works", href: `${DOCS}/how-it-works/` },
                  { label: "Recovery & idempotency", href: `${DOCS}/contribute/recovery-and-idempotency/` },
                  { label: "Architecture deep-dive", href: "/blog/architecture-durable-objects-r2-brain-sandbox-split/" },
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
                resources: [
                  { id: "cloudflare", label: "Cloudflare", href: `${DOCS}/deploy/cloudflare/` },
                  { id: "kubernetes", label: "Kubernetes", href: `${DOCS}/deploy/kubernetes/` },
                  { id: "openshell", label: "NVIDIA OpenShell", href: `${DOCS}/deploy/k8s-bridge/` },
                  { id: "e2b", label: "E2B", href: `${DOCS}/reference/configuration/` },
                  { id: "daytona", label: "Daytona", href: `${DOCS}/reference/configuration/` },
                  { id: "docker-compose", label: "Docker", href: `${DOCS}/deploy/docker/` },
                  { id: "subprocess", label: "Your own machine", href: `${DOCS}/quickstart/` },
                ],
                links: [
                  { label: "Deploy overview", href: `${DOCS}/deploy/` },
                  { label: "Architecture deep-dive", href: "/blog/architecture-durable-objects-r2-brain-sandbox-split/" },
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
                resources: [
                  { id: "github", label: "GitHub", href: `${DOCS}/build/integrations/` },
                  { id: "slack", label: "Slack", href: `${DOCS}/console/integrations/` },
                  { id: "telegram", label: "Telegram", href: `${DOCS}/build/integrations/` },
                  { id: "linear", label: "Linear", href: `${DOCS}/console/integrations/` },
                ],
                links: [
                  { label: "Integrations guide", href: `${DOCS}/build/integrations/` },
                  { label: "Console integrations", href: `${DOCS}/console/integrations/` },
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
                links: [
                  { label: "Console getting started", href: `${DOCS}/console/getting-started/` },
                  { label: "An open-source Claude Tag", href: "/blog/claude-tag-open-source-alternative/" },
                  { label: "Self-hosted Claude Tag", href: "/blog/self-hosted-claude-tag-open-source/" },
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
          {dialog?.resources && (
            <>
              <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.12em] text-fg-subtle">
                Supported
              </p>
              <ResourceGrid items={dialog.resources} />
            </>
          )}
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
          {dialog?.links && (
            <div className="mt-4 border-t border-border pt-3">
              <p className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-fg-subtle">
                Learn more
              </p>
              <ul className="space-y-1">
                {dialog.links.map((l) => (
                  <li key={l.href + l.label}>
                    <a
                      href={l.href}
                      target={l.href.startsWith("http") ? "_blank" : undefined}
                      rel={l.href.startsWith("http") ? "noreferrer" : undefined}
                      className="text-[0.8rem] text-brand hover:underline"
                    >
                      {l.label} →
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </dialog>
    </div>
  );
}
