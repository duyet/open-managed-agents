import { useEffect, useRef, useState } from "react";

/**
 * Interactive architecture diagram for the oma landing-page hero.
 *
 * Renders an SVG component map of the platform and auto-traces a request
 * through it (Client → API → SessionDO → Harness → Sandbox → Vault proxy →
 * external service). Hovering/clicking a node surfaces its role + connections.
 *
 * Theme-aware: every fill/stroke uses the site's CSS custom properties, so
 * light + dark apply automatically. Reduced-motion users get a static diagram
 * with the full path pre-highlighted instead of an animation.
 */

type Accent = "orange" | "blue" | "green";

interface Node {
  id: string;
  label: string;
  sub: string;
  accent: Accent;
  /** SVG x/y of the top-left of the node box. */
  x: number;
  y: number;
  w: number;
  h: number;
  role: string;
}

interface Edge {
  from: string;
  to: string;
}

// Diagram coordinate space (viewBox 0 0 600 360).
const NODES: Node[] = [
  {
    id: "client",
    label: "Client",
    sub: "Console · CLI · API",
    accent: "orange",
    x: 20,
    y: 24,
    w: 132,
    h: 52,
    role: "Any client that speaks the same HTTP surface — the web Console, the oma CLI, or a custom integration.",
  },
  {
    id: "session",
    label: "SessionDO",
    sub: "Durable state · SQLite",
    accent: "blue",
    x: 234,
    y: 24,
    w: 132,
    h: 52,
    role: "Per-session Durable Object with an append-only SQLite event log. Owns state, tool catalog, skills mount, and sandbox binding.",
  },
  {
    id: "harness",
    label: "Harness",
    sub: "Model loop · policy",
    accent: "green",
    x: 448,
    y: 24,
    w: 132,
    h: 52,
    role: "Decides how to drive the model — context, compaction, tool steps. Default harness ships; custom harnesses register by name.",
  },
  {
    id: "sandbox",
    label: "Sandbox",
    sub: "CF · Docker · k8s · subprocess",
    accent: "blue",
    x: 448,
    y: 150,
    w: 132,
    h: 52,
    role: "Isolated execution for bash, files, packages, and MCP calls. Never sees raw vault material.",
  },
  {
    id: "vault",
    label: "Vault Proxy",
    sub: "Outbound secrets",
    accent: "orange",
    x: 234,
    y: 150,
    w: 132,
    h: 52,
    role: "Intercepts outbound HTTPS and injects credentials at the network edge — tokens never enter the sandbox.",
  },
  {
    id: "ext",
    label: "External",
    sub: "LLM · GitHub · APIs",
    accent: "orange",
    x: 20,
    y: 150,
    w: 132,
    h: 52,
    role: "Upstream services the agent calls: Anthropic, OpenAI-compatible gateways, GitHub, MCP servers.",
  },
  {
    id: "agent",
    label: "Agent cfg",
    sub: "versioned config",
    accent: "orange",
    x: 234,
    y: 276,
    w: 132,
    h: 48,
    role: "A versioned config: model, system prompt, tools, skills, MCP servers, harness. Sessions bind to a fixed version.",
  },
  {
    id: "env",
    label: "Environment",
    sub: "sandbox image",
    accent: "green",
    x: 448,
    y: 276,
    w: 132,
    h: 48,
    role: "The execution sandbox definition — packages, networking policy, container image. Reusable across a fleet.",
  },
];

const EDGES: Edge[] = [
  { from: "client", to: "session" },
  { from: "session", to: "harness" },
  { from: "harness", to: "sandbox" },
  { from: "sandbox", to: "vault" },
  { from: "vault", to: "ext" },
  { from: "vault", to: "session" },
  { from: "agent", to: "session" },
  { from: "env", to: "sandbox" },
];

// Ordered data-flow path for the animation.
const FLOW: string[] = ["client", "session", "harness", "sandbox", "vault", "ext"];

// Real protocol trace for each flow step — actual API surface, event names,
// and CLI, not invented flags. Shown as the terminal's live request trace.
const TRACE: Record<string, string> = {
  client: '$ oma sessions message sess_9f2 "run the tests"  →  POST /v1/sessions/sess_9f2/events',
  session: "event: session.status_running   (persisted to DO-SQLite, then broadcast)",
  harness: "span.model_request_start · claude-sonnet-4-6 · byte-stable prompt prefix",
  sandbox: 'agent.tool_use · bash · {"command":"pnpm test"}',
  vault: "outbound https://api.github.com → proxy injects Authorization (never in sandbox)",
  ext: "agent.message → session.status_idle · stop_reason: end_turn",
};

function nodeById(id: string): Node {
  const n = NODES.find((x) => x.id === id);
  if (!n) throw new Error(`unknown node ${id}`);
  return n;
}

/** Edge endpoints: connect box edges at sensible anchor points. */
function edgePath(e: Edge): string {
  const a = nodeById(e.from);
  const b = nodeById(e.to);
  // Right→left (same row) vs bottom→top (stacked) vs left→right.
  if (a.y === b.y) {
    const left = a.x < b.x ? a : b;
    const right = a.x < b.x ? b : a;
    const y = a.y + a.h / 2;
    return `M ${left.x + left.w} ${y} L ${right.x} ${y}`;
  }
  // a above b → bottom-center of a to top-center of b
  const x = a.x + a.w / 2;
  return `M ${x} ${a.y + a.h} L ${x} ${b.y}`;
}

export default function ArchDiagram() {
  const reduceMotion =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  const [step, setStep] = useState(0); // index into FLOW
  const [hover, setHover] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (reduceMotion) return;
    timer.current = window.setInterval(() => {
      setStep((s) => (s + 1) % FLOW.length);
    }, 1100);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [reduceMotion]);

  const activeNode = reduceMotion ? null : FLOW[step];
  const activeEdges = new Set<string>();
  if (reduceMotion) {
    // highlight the whole path statically
    for (let i = 0; i < FLOW.length - 1; i++) activeEdges.add(`${FLOW[i]}-${FLOW[i + 1]}`);
  } else {
    const cur = FLOW[step];
    const next = FLOW[(step + 1) % FLOW.length];
    activeEdges.add(`${cur}-${next}`);
    // also light the feedback edge vault→session when on that step
    if (cur === "ext") activeEdges.add("vault-session");
  }

  const tipNode = hover ? nodeById(hover) : null;
  // Caption shows the hovered node's role, falling back to the active flow node.
  const captionNode = tipNode ?? (activeNode ? nodeById(activeNode) : null);

  return (
    <div className="arch-diagram-wrap">
      <svg
        className="arch-diagram"
        viewBox="0 0 600 340"
        role="img"
        aria-label="oma architecture: Client and API call into SessionDO (durable state), which drives the Harness (model loop); the Harness runs in a Sandbox whose outbound calls are authenticated by the Vault Proxy before reaching external services. Agent config and Environment define each session."
      >
        <title>oma component architecture and request flow</title>
        <desc>
          Client and API call into SessionDO (durable state), which drives the Harness (model
          loop); the Harness runs in a Sandbox whose outbound calls are authenticated by the Vault
          Proxy before reaching external services. Agent config and Environment define each session.
        </desc>

        {/* edges first, under nodes */}
        {EDGES.map((e) => {
          const key = `${e.from}-${e.to}`;
          const isActive = activeEdges.has(key);
          return (
            <path
              key={key}
              className={`ad-edge${isActive ? " is-active" : ""}`}
              d={edgePath(e)}
            />
          );
        })}

        {/* nodes */}
        {NODES.map((n) => {
          const isActive = activeNode === n.id || (reduceMotion && FLOW.includes(n.id));
          return (
            <g
              key={n.id}
              className={`ad-node ad-${n.accent}${isActive ? " is-active" : ""}`}
              tabIndex={0}
              role="button"
              aria-label={`${n.label}: ${n.role}`}
              onMouseEnter={() => setHover(n.id)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(n.id)}
              onBlur={() => setHover(null)}
            >
              <rect rx={8} ry={8} x={n.x} y={n.y} width={n.w} height={n.h} />
              <text x={n.x + n.w / 2} y={n.y + n.h / 2 - 3} textAnchor="middle">
                {n.label}
              </text>
              <text className="ad-sub" x={n.x + n.w / 2} y={n.y + n.h / 2 + 13} textAnchor="middle">
                {n.sub}
              </text>
              {/* Brand mark (bracket+dot) drawn inline so it's theme-aware —
                  the brackets + dot inherit the node's accent via currentColor. */}
              {n.id === "client" && (
                <g className="ad-brand" transform={`translate(${n.x + n.w / 2}, ${n.y - 14})`}>
                  <path
                    className="ad-brand-bracket"
                    d="M-11 -7 H-16 V7 H-11 M11 -7 H16 V7 H11"
                    fill="none"
                    strokeWidth={2.4}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <circle className="ad-brand-dot" cx="0" cy="0" r="3.4" />
                </g>
              )}
            </g>
          );
        })}
      </svg>

      {/* Live request trace — the real protocol line for the active step
          (actual endpoints, event names, CLI). Hover swaps to the node's role. */}
      <p className="arch-diagram-trace font-mono" aria-live="polite">
        <span className="ad-trace-step">
          {activeNode ? `${FLOW.indexOf(activeNode) + 1}/${FLOW.length}` : "—"}
        </span>
        {activeNode ? TRACE[activeNode] : TRACE.client}
      </p>

      {/* HTML caption — wraps freely, unlike SVG text. Updates on hover or
          with the active flow node when nothing is hovered. */}
      <p className="arch-diagram-caption" aria-live="polite">
        <span className="ad-caption-label">{captionNode ? captionNode.label : "oma"}</span>
        {captionNode ? captionNode.role : "Components and how they connect."}
      </p>
    </div>
  );
}
