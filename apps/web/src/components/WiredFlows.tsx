// "One agent, wired to your stack" — tabbed use-case diagrams. Each tab is
// one real agent template drawn as a pipeline of nodes: input(s) → the agent
// (with its sandbox / skills / memory / MCP layers visible) → outputs.
// Brand marks (GitHub, Slack, Linear, Sentry, Kubernetes) are simple-icons
// paths; the rest are hand-drawn stroke glyphs.
import { useState } from "react";
import type { ReactNode } from "react";

/* ── Icons ──────────────────────────────────────────────────────────── */

const BRAND_PATHS: Record<string, string> = {
  github:
    "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
  slack:
    "M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z",
  linear:
    "M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z",
  sentry:
    "M13.91 2.505c-.873-1.448-2.972-1.448-3.844 0L6.904 7.92a15.478 15.478 0 0 1 8.53 12.811h-2.221A13.301 13.301 0 0 0 5.784 9.814l-2.926 5.06a7.65 7.65 0 0 1 4.435 5.848H2.194a.365.365 0 0 1-.298-.534l1.413-2.402a5.16 5.16 0 0 0-1.614-.913L.296 19.275a2.182 2.182 0 0 0 .812 2.999 2.24 2.24 0 0 0 1.086.288h6.983a9.322 9.322 0 0 0-3.845-8.318l1.11-1.922a11.47 11.47 0 0 1 4.95 10.24h5.915a17.242 17.242 0 0 0-7.885-15.28l2.244-3.845a.37.37 0 0 1 .504-.13c.255.14 9.75 16.708 9.928 16.9a.365.365 0 0 1-.327.543h-2.287c.029.612.029 1.223 0 1.831h2.297a2.206 2.206 0 0 0 1.922-3.31z",
};

/** Hand-drawn stroke glyphs (16×16, stroke=currentColor). */
const STROKE_GLYPHS: Record<string, ReactNode> = {
  file: (
    <>
      <path d="M4 1.5h5.5L13 5v9.5H4z" />
      <path d="M9.5 1.5V5H13" />
    </>
  ),
  chart: (
    <>
      <path d="M2 14h12" />
      <path d="M4 14V9M8 14V4M12 14v-7" />
    </>
  ),
  doc: (
    <>
      <path d="M3.5 1.5h9v13h-9z" />
      <path d="M5.5 5h5M5.5 8h5M5.5 11h3" />
    </>
  ),
  clock: (
    <>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 4.5V8l2.5 1.5" />
    </>
  ),
  laptop: (
    <>
      <path d="M3 3.5h10V11H3z" />
      <path d="M1.5 13.5h13" />
    </>
  ),
  cluster: (
    <>
      <path d="M8 1.5 13.8 5v6L8 14.5 2.2 11V5z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  pr: (
    <>
      <circle cx="4" cy="3.5" r="1.8" />
      <circle cx="4" cy="12.5" r="1.8" />
      <circle cx="12" cy="12.5" r="1.8" />
      <path d="M4 5.3v5.4M12 10.7V7a3 3 0 0 0-3-3H7.5" />
    </>
  ),
  check: <path d="M3 8.5 6.5 12 13 4.5" />,
  terminal: (
    <>
      <path d="M1.5 2.5h13v11h-13z" />
      <path d="M4 6l2.5 2L4 10M8 10.5h4" />
    </>
  ),
};

function Icon({ name, size = 14 }: { name: string; size?: number }) {
  if (BRAND_PATHS[name]) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style={{ flex: "none" }}>
        <path d={BRAND_PATHS[name]} />
      </svg>
    );
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flex: "none" }}
    >
      {STROKE_GLYPHS[name]}
    </svg>
  );
}

/* ── Flow data ──────────────────────────────────────────────────────── */

interface DiagramNode {
  icon: string;
  label: string;
  /** smaller second line, e.g. a filename or a status */
  sub?: string;
}

interface Flow {
  name: string;
  every?: string;
  inputs: DiagramNode[];
  /** layer chips shown inside the agent box */
  layers: { icon: string; label: string }[];
  outputs: DiagramNode[];
  /** one-line caption under the diagram */
  note?: string;
  /** extra: terminal line rendered inside the laptop input (local relay) */
  laptopCmd?: string;
}

const FLOWS: Flow[] = [
  {
    name: "Support",
    inputs: [{ icon: "slack", label: "Slack", sub: "customer asks" }],
    layers: [
      { icon: "terminal", label: "sandbox" },
      { icon: "doc", label: "skills: docs-lookup" },
      { icon: "file", label: "memory" },
    ],
    outputs: [{ icon: "slack", label: "reply in-thread" }],
    note: "Customer threads open sessions; answers are drafted from your docs.",
  },
  {
    name: "Incident response",
    inputs: [{ icon: "sentry", label: "Sentry", sub: "alert webhook" }],
    layers: [
      { icon: "terminal", label: "sandbox: triage" },
      { icon: "cluster", label: "mcp: linear" },
    ],
    outputs: [
      { icon: "linear", label: "Linear ticket" },
      { icon: "slack", label: "war room" },
    ],
    note: "Alert fires the deployment webhook; the session triages and escalates.",
  },
  {
    name: "Sprint retro",
    every: "weekly",
    inputs: [{ icon: "clock", label: "schedule", sub: "Fri 17:00" }],
    layers: [
      { icon: "cluster", label: "mcp: linear" },
      { icon: "file", label: "memory: past retros" },
      { icon: "doc", label: "skills: writing" },
    ],
    outputs: [{ icon: "doc", label: "retro doc" }],
    note: "A cron schedule opens a fresh session every Friday.",
  },
  {
    name: "Bug triage",
    inputs: [{ icon: "github", label: "GitHub issue", sub: "@agent mentioned" }],
    layers: [
      { icon: "terminal", label: "sandbox: repro" },
      { icon: "doc", label: "skills: debugging" },
      { icon: "file", label: "memory" },
    ],
    outputs: [
      { icon: "pr", label: "branch + PR", sub: "fix committed" },
      { icon: "github", label: "issue comment" },
    ],
    note: "The agent reproduces in its sandbox, checks out a branch, commits the fix, and opens a PR.",
  },
  {
    name: "Data analysis",
    inputs: [{ icon: "file", label: "dataset upload", sub: "sales.csv" }],
    layers: [
      { icon: "terminal", label: "sandbox: python" },
      { icon: "chart", label: "skills: charts" },
      { icon: "doc", label: "skills: report" },
    ],
    outputs: [
      { icon: "chart", label: "charts" },
      { icon: "doc", label: "HTML report", sub: "/workspace/out" },
    ],
    note: "pandas + matplotlib run in the sandbox; outputs land as files in /workspace.",
  },
  {
    name: "Local relay",
    inputs: [
      {
        icon: "laptop",
        label: "your laptop",
        sub: "daemon connected",
      },
      { icon: "github", label: "GitHub ticket", sub: "assigned to agent" },
    ],
    laptopCmd: "npx @getoma/cli bridge setup",
    layers: [
      { icon: "terminal", label: "tools exec on your machine" },
      { icon: "doc", label: "outbound-only WebSocket" },
    ],
    outputs: [
      { icon: "pr", label: "PR auto-created" },
      { icon: "check", label: "ticket marked done" },
    ],
    note: "Assign a ticket in the cloud — the agent runs against your machine, commits on a branch, and opens the PR.",
  },
  {
    name: "K8s sandbox",
    inputs: [{ icon: "cluster", label: "your cluster", sub: "helm install" }],
    layers: [
      { icon: "terminal", label: "pod-per-session sandbox" },
      { icon: "doc", label: "image + network policy from env" },
    ],
    outputs: [{ icon: "check", label: "isolated runs" }],
    note: "Each session provisions a pod in your cluster via the k8s bridge.",
  },
];

/* ── Diagram pieces ─────────────────────────────────────────────────── */

const nodeStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  border: "1px solid var(--color-border)",
  background: "var(--color-bg-surface)",
  borderRadius: "0.5rem",
  padding: "0.5rem 0.7rem",
  fontFamily: "var(--font-mono)",
  fontSize: "0.68rem",
  lineHeight: 1.25,
  color: "var(--color-fg)",
};

function Node({ node }: { node: DiagramNode }) {
  return (
    <div style={nodeStyle}>
      <Icon name={node.icon} />
      <span style={{ minWidth: 0 }}>
        <span style={{ display: "block", whiteSpace: "nowrap" }}>{node.label}</span>
        {node.sub && (
          <span style={{ display: "block", color: "var(--color-fg-subtle)", fontSize: "0.6rem", whiteSpace: "nowrap" }}>
            {node.sub}
          </span>
        )}
      </span>
    </div>
  );
}

function Arrow() {
  return (
    <svg
      width="26"
      height="10"
      viewBox="0 0 26 10"
      aria-hidden="true"
      style={{ flex: "none", color: "var(--color-border-strong)", alignSelf: "center" }}
    >
      <path
        d="M0 5h21M18 1.5 22.5 5 18 8.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* ── Component ──────────────────────────────────────────────────────── */

export default function WiredFlows() {
  const [active, setActive] = useState(0);
  const flow = FLOWS[active];

  return (
    <div style={{ width: "100%", padding: "0.25rem 0.25rem 0" }}>
      <p
        className="font-mono"
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: "0.75rem",
          margin: "0 0 0.75rem",
          fontSize: "0.72rem",
          fontWeight: 600,
          color: "var(--color-fg)",
        }}
      >
        <span>One agent, wired to your stack</span>
        <span style={{ fontWeight: 400, color: "var(--color-fg-subtle)", whiteSpace: "nowrap" }} aria-hidden="true">
          input → agent → result
        </span>
      </p>

      {/* Tab rail */}
      <div role="tablist" aria-label="Use cases" style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem", margin: "0 0 1.1rem" }}>
        {FLOWS.map((f, i) => (
          <button
            key={f.name}
            role="tab"
            aria-selected={i === active}
            onClick={() => setActive(i)}
            className="font-mono"
            style={{
              fontSize: "11px",
              padding: "0.3rem 0.65rem",
              borderRadius: "999px",
              cursor: "pointer",
              border: `1px solid ${i === active ? "var(--color-brand)" : "var(--color-border)"}`,
              background: i === active ? "color-mix(in srgb, var(--color-brand) 10%, transparent)" : "transparent",
              color: i === active ? "var(--color-brand)" : "var(--color-fg-muted)",
              transition: "color .15s ease, border-color .15s ease, background-color .15s ease",
            }}
          >
            {f.name}
          </button>
        ))}
      </div>

      {/* Diagram: inputs → agent (layers) → outputs */}
      <div
        style={{
          display: "flex",
          alignItems: "stretch",
          flexWrap: "wrap",
          gap: "0.5rem 0.4rem",
          padding: "1rem",
          border: "1px dashed var(--color-border)",
          borderRadius: "0.75rem",
        }}
      >
        {/* Inputs */}
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: "0.5rem" }}>
          {flow.inputs.map((n, i) => (
            <div key={n.label}>
              <Node node={n} />
              {/* Local relay: the paired-CLI terminal line lives inside the laptop input */}
              {i === 0 && flow.laptopCmd && (
                <div
                  className="font-mono"
                  style={{
                    marginTop: "0.35rem",
                    padding: "0.35rem 0.55rem",
                    borderRadius: "0.4rem",
                    border: "1px solid var(--color-border)",
                    background: "var(--color-bg)",
                    fontSize: "0.58rem",
                    color: "var(--color-fg-muted)",
                    whiteSpace: "nowrap",
                  }}
                >
                  <span style={{ color: "var(--color-fg-subtle)" }}>$ </span>
                  {flow.laptopCmd}
                  <span style={{ display: "block", color: "var(--color-success, #22c55e)" }}>✓ connected</span>
                </div>
              )}
            </div>
          ))}
        </div>

        <Arrow />

        {/* Agent box with its layers */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.45rem",
            padding: "0.7rem 0.8rem",
            borderRadius: "0.6rem",
            border: "1px solid color-mix(in srgb, var(--color-brand) 40%, transparent)",
            background: "color-mix(in srgb, var(--color-brand) 6%, var(--color-bg))",
            minWidth: "11rem",
          }}
        >
          <div
            className="font-mono"
            style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.7rem", fontWeight: 600, color: "var(--color-brand)" }}
          >
            <span
              aria-hidden="true"
              style={{ width: "0.42rem", height: "0.42rem", borderRadius: "1px", background: "var(--color-brand)", transform: "rotate(45deg)" }}
            ></span>
            agent
            {flow.every && (
              <span style={{ fontWeight: 500, fontSize: "0.6rem", color: "var(--color-fg-subtle)", marginLeft: "auto" }}>↻ {flow.every}</span>
            )}
          </div>
          {flow.layers.map((l) => (
            <div
              key={l.label}
              className="font-mono"
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.45rem",
                padding: "0.35rem 0.5rem",
                borderRadius: "0.4rem",
                border: "1px solid var(--color-border)",
                background: "var(--color-bg)",
                fontSize: "0.62rem",
                color: "var(--color-fg-muted)",
                whiteSpace: "nowrap",
              }}
            >
              <Icon name={l.icon} size={12} />
              {l.label}
            </div>
          ))}
        </div>

        <Arrow />

        {/* Outputs */}
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: "0.5rem" }}>
          {flow.outputs.map((n) => (
            <Node key={n.label} node={n} />
          ))}
        </div>
      </div>

      {flow.note && (
        <p style={{ margin: "0.7rem 0 0", fontSize: "0.74rem", lineHeight: 1.5, color: "var(--color-fg-muted)" }}>{flow.note}</p>
      )}
    </div>
  );
}
