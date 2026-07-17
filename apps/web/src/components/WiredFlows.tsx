// "One agent, wired to your stack" — tabbed use-case demos. Each tab is one
// real agent template: its trigger → agent → outputs pipeline on top, and a
// small terminal-style demo underneath showing how you'd actually wire it.
// Reuses the hero-flow / flow-node CSS classes from global.css.
import { useState } from "react";

interface Flow {
  name: string;
  trigger: string;
  outputs: string[];
  every?: string;
  /** Terminal-style demo lines. `$ `-prefixed lines render as commands. */
  demo: string[];
}

const FLOWS: Flow[] = [
  {
    name: "Support",
    trigger: "customer asks",
    outputs: ["docs lookup", "slack reply"],
    demo: [
      "$ oma agents create support-bot --model claude-sonnet-4-6",
      "$ oma slack publish <agent-id> --env <env-id>",
      "✓ published — customer threads now open sessions",
      "→ answer drafted from docs, replied in-thread",
    ],
  },
  {
    name: "Incident response",
    trigger: "sentry alert",
    outputs: ["linear ticket", "slack room"],
    demo: [
      "$ curl -X POST $BASE/v1/deployments -d '{",
      "    \"trigger\": {\"type\": \"webhook\"}, ... }'",
      "✓ webhook_url minted — point Sentry at it",
      "→ alert fires → session triages → ticket + war room",
    ],
  },
  {
    name: "Sprint retro",
    trigger: "sprint closes",
    outputs: ["retro doc"],
    every: "weekly",
    demo: [
      "$ oma schedules create <agent-id> \\",
      "    --cron '0 17 * * 5' --env <env-id> \\",
      "    --input 'Write the sprint retro from Linear'",
      "✓ fires every Friday 17:00 — fresh session each run",
    ],
  },
  {
    name: "Bug triage",
    trigger: "intercom thread",
    outputs: ["repro", "jira issue"],
    demo: [
      "$ oma github bind <agent-id> --env <env-id>",
      "✓ installed — issues mention @support-bot",
      "→ agent reproduces in its sandbox, files the issue",
      "→ status posted back as an issue comment",
    ],
  },
  {
    name: "Data analysis",
    trigger: "dataset",
    outputs: ["charts", "report"],
    demo: [
      "$ oma sessions create --agent analyst --env py-env",
      "$ oma sessions chat <id> 'Analyze /data/sales.csv'",
      "→ pandas + matplotlib run in the sandbox",
      "→ charts and a written report in /workspace/out",
    ],
  },
  {
    name: "Local relay",
    trigger: "your laptop",
    outputs: ["sandbox on your machine"],
    demo: [
      "$ npx @getoma/cli bridge setup",
      "✓ paired macbook-pro.local — daemon connected",
      "$ oma envs create local  # sandbox_provider: subprocess",
      "→ cloud session, tools exec on YOUR machine",
      "  outbound-only WebSocket — no inbound ports",
    ],
  },
  {
    name: "K8s sandbox",
    trigger: "your cluster",
    outputs: ["pod-per-sandbox"],
    demo: [
      "$ helm install oma-k8s-bridge ./charts/oma-k8s-bridge \\",
      "    -n sandboxes --set secret.existingSecret=oma-token",
      "$ oma envs create k8s  # sandbox_provider: k8s-bridge",
      "→ each session provisions a pod in your cluster",
      "  image, packages, and network policy from the env",
    ],
  },
];

export default function WiredFlows() {
  const [active, setActive] = useState(0);
  const flow = FLOWS[active];

  return (
    <div className="hero-flows-panel">
      <p className="hero-flows-head">
        <span>One agent, wired to your stack</span>
        <span className="hero-flows-legend" aria-hidden="true">
          trigger → agent → result
        </span>
      </p>

      {/* Tab rail */}
      <div
        role="tablist"
        aria-label="Use cases"
        style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem", margin: "0.75rem 0 1rem" }}
      >
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

      {/* Active flow pipeline */}
      <div className="hero-flow" style={{ borderTop: 0 }}>
        <div className="hero-flow-name">
          <span>{flow.name}</span>
          {flow.every && <span className="hero-flow-every">↻ {flow.every}</span>}
        </div>
        <div className="hero-flow-pipe">
          <span className="flow-node flow-trigger">{flow.trigger}</span>
          <span className="flow-step">
            <svg className="flow-arrow" width="20" height="8" viewBox="0 0 20 8" aria-hidden="true">
              <path d="M0 4h16M13 1l4 3-4 3" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="flow-node flow-agent">
              <span className="flow-agent-mark" aria-hidden="true"></span>agent
            </span>
          </span>
          <span className="flow-step">
            <svg className="flow-arrow" width="20" height="8" viewBox="0 0 20 8" aria-hidden="true">
              <path d="M0 4h16M13 1l4 3-4 3" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="flow-out">
              {flow.outputs.map((o) => (
                <span key={o} className="flow-node">{o}</span>
              ))}
            </span>
          </span>
        </div>
      </div>

      {/* Demo */}
      <pre
        style={{
          margin: "0.85rem 0 0",
          padding: "0.85rem 1rem",
          borderRadius: "8px",
          border: "1px solid var(--color-border)",
          background: "color-mix(in srgb, var(--color-bg-surface) 55%, transparent)",
          fontSize: "12px",
          lineHeight: 1.65,
          overflowX: "auto",
        }}
      >
        <code>
          {flow.demo.map((line, i) => {
            const cmd = line.startsWith("$ ");
            const ok = line.startsWith("✓");
            return (
              <span
                key={i}
                style={{
                  display: "block",
                  color: cmd
                    ? "var(--color-fg)"
                    : ok
                      ? "var(--color-success, #22c55e)"
                      : "var(--color-fg-muted)",
                }}
              >
                {cmd ? (
                  <>
                    <span style={{ color: "var(--color-fg-subtle)" }}>$ </span>
                    {line.slice(2)}
                  </>
                ) : (
                  line
                )}
              </span>
            );
          })}
        </code>
      </pre>
    </div>
  );
}
