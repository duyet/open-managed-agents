import { useEffect, useState } from "react";

/**
 * Live "stacked-assembly" demo for the landing-page hero.
 *
 * Echoes the Console's "How it fits together" panel (StackedAssembly.tsx):
 * one hero Agent card on top, then the building-block chips it *uses* —
 * Model, MCP / Connections, Skills, Runs on, Keys / Vault, Chat / Channels —
 * each with a small status dot. Where the Console renders live tenant data,
 * this landing version is a looping *demo*: it assembles the blocks one by
 * one, then plays a tiny simulated run (a user message → the agent lights up
 * the blocks it touches → a result) before resetting and looping.
 *
 * Theme-aware: every colour is a site CSS custom property, so light + dark
 * apply automatically. Reduced-motion users get the clean, fully-assembled
 * static state (all blocks ready, the run's result shown) with no animation.
 */

type Accent = "orange" | "blue" | "green";

interface BlockDef {
  key: string;
  label: string;
  summary: string;
  accent: Accent;
  /** lucide-style single-path(s), stroke via currentColor. */
  icon: string;
}

const AGENT_LABEL = "Coder";
const AGENT_SUMMARY = "model · skills · tools · sandbox";

const BLOCKS: BlockDef[] = [
  {
    key: "model",
    label: "Model",
    summary: "claude-sonnet-4-6",
    accent: "orange",
    icon: `<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/>`,
  },
  {
    key: "mcp",
    label: "MCP / Connections",
    summary: "github, linear",
    accent: "blue",
    icon: `<path d="M12 22v-5"/><path d="M9 8V2M15 8V2"/><path d="M18 8v3a6 6 0 0 1-12 0V8z"/>`,
  },
  {
    key: "skills",
    label: "Skills",
    summary: "code-review, tdd",
    accent: "green",
    icon: `<path d="M9.94 6.06 9 4 8.06 6.06 6 7l2.06.94L9 10l.94-2.06L12 7z"/><path d="M17 11l-.7 1.6-1.6.7 1.6.7.7 1.6.7-1.6 1.6-.7-1.6-.7z"/><path d="M6.5 14l-.5 1.2-1.2.5 1.2.5.5 1.2.5-1.2 1.2-.5-1.2-.5z"/>`,
  },
  {
    key: "runtime",
    label: "Runs on",
    summary: "Cloudflare · Docker",
    accent: "blue",
    icon: `<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01"/>`,
  },
  {
    key: "vault",
    label: "Keys / Vault",
    summary: "prod-secrets",
    accent: "orange",
    icon: `<circle cx="8" cy="15" r="4"/><path d="m10.85 12.15 8.15-8.15M17 5l2 2M14 8l2 2"/>`,
  },
  {
    key: "chat",
    label: "Chat / Channels",
    summary: "Telegram, Slack",
    accent: "green",
    icon: `<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>`,
  },
];

// The looping timeline. Each entry advances on a fixed tick; the render derives
// what's visible/active from the current step. Kept declarative so the whole
// demo reads top-to-bottom.
//
// Phase A (assemble): agent card, then blocks reveal one by one.
// Phase B (run): a user message arrives, the agent goes "thinking", the blocks
//   it touches pulse in turn, then a result lands.
type Phase =
  | { kind: "reset" }
  | { kind: "agent" }
  | { kind: "reveal"; upto: number } // blocks 0..upto revealed
  | { kind: "assembled" }
  | { kind: "message" }
  | { kind: "think" }
  | { kind: "active"; block: string } // one block pulsing
  | { kind: "result" }
  | { kind: "hold" };

const TIMELINE: Phase[] = [
  { kind: "reset" },
  { kind: "agent" },
  { kind: "reveal", upto: 0 },
  { kind: "reveal", upto: 1 },
  { kind: "reveal", upto: 2 },
  { kind: "reveal", upto: 3 },
  { kind: "reveal", upto: 4 },
  { kind: "reveal", upto: 5 },
  { kind: "assembled" },
  { kind: "message" },
  { kind: "think" },
  { kind: "active", block: "model" },
  { kind: "active", block: "skills" },
  { kind: "active", block: "runtime" },
  { kind: "active", block: "mcp" },
  { kind: "active", block: "chat" },
  { kind: "result" },
  { kind: "hold" },
  { kind: "hold" },
];

const TICK_MS = 780;
const USER_MSG = "ship a fix for issue #128";
const RESULT_MSG = "opened PR #128 — 4 files, tests green";

function BlockIcon({ path }: { path: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: path }}
    />
  );
}

export default function AssemblyDemo() {
  const reduceMotion =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  const [step, setStep] = useState(0);

  useEffect(() => {
    if (reduceMotion) return;
    const id = window.setInterval(() => {
      setStep((s) => (s + 1) % TIMELINE.length);
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [reduceMotion]);

  const phase = TIMELINE[step];

  // Derive render flags from the current phase. Reduced motion short-circuits
  // to the fully-assembled + result state.
  let agentOn = false;
  let agentThinking = false;
  let revealedUpto = -1; // highest revealed block index
  let activeKey: string | null = null;
  let showMessage = false;
  let showResult = false;

  if (reduceMotion) {
    agentOn = true;
    revealedUpto = BLOCKS.length - 1;
    showMessage = true;
    showResult = true;
  } else {
    switch (phase.kind) {
      case "reset":
        break;
      case "agent":
        agentOn = true;
        break;
      case "reveal":
        agentOn = true;
        revealedUpto = phase.upto;
        break;
      case "assembled":
        agentOn = true;
        revealedUpto = BLOCKS.length - 1;
        break;
      case "message":
        agentOn = true;
        revealedUpto = BLOCKS.length - 1;
        showMessage = true;
        break;
      case "think":
        agentOn = true;
        agentThinking = true;
        revealedUpto = BLOCKS.length - 1;
        showMessage = true;
        break;
      case "active":
        agentOn = true;
        agentThinking = true;
        revealedUpto = BLOCKS.length - 1;
        showMessage = true;
        activeKey = phase.block;
        break;
      case "result":
      case "hold":
        agentOn = true;
        revealedUpto = BLOCKS.length - 1;
        showMessage = true;
        showResult = true;
        break;
    }
  }

  return (
    <div className="asm" aria-hidden="true">
      {/* Hero agent card */}
      <div className={`asm-agent asm-orange${agentOn ? " is-on" : ""}${agentThinking ? " is-thinking" : ""}`}>
        <span className="asm-agent-mark" aria-hidden="true">
          <span className="asm-bracket">[</span>
          <span className="asm-dot" />
          <span className="asm-bracket">]</span>
        </span>
        <span className="asm-agent-body">
          <span className="asm-agent-name">{AGENT_LABEL} agent</span>
          <span className="asm-agent-sub">
            {agentThinking ? (
              <span className="asm-typing">
                <i /> <i /> <i /> working
              </span>
            ) : (
              AGENT_SUMMARY
            )}
          </span>
        </span>
        <span className={`asm-status${agentOn ? " is-ready" : ""}`} />
      </div>

      {/* "uses" connector */}
      <div className="asm-uses">
        <span className="asm-rule" />
        <span>uses</span>
        <span className="asm-rule" />
      </div>

      {/* Building-block grid */}
      <div className="asm-grid">
        {BLOCKS.map((b, i) => {
          const revealed = i <= revealedUpto;
          const active = activeKey === b.key;
          return (
            <div
              key={b.key}
              className={`asm-block asm-${b.accent}${revealed ? " is-revealed" : ""}${active ? " is-active" : ""}`}
            >
              <span className="asm-block-icon">
                <BlockIcon path={b.icon} />
              </span>
              <span className="asm-block-body">
                <span className="asm-block-label">{b.label}</span>
                <span className="asm-block-sum">{b.summary}</span>
              </span>
              <span className={`asm-status${revealed ? " is-ready" : ""}`} />
            </div>
          );
        })}
      </div>

      {/* Run strip: user message → result */}
      <div className="asm-run">
        <div className={`asm-msg asm-msg-user${showMessage ? " is-in" : ""}`}>
          <span className="asm-msg-tag">you</span>
          <span className="asm-msg-text">{USER_MSG}</span>
        </div>
        <div className={`asm-msg asm-msg-agent${showResult ? " is-in" : ""}`}>
          <span className="asm-msg-tag asm-msg-tag-agent">{AGENT_LABEL}</span>
          <span className="asm-msg-text">{RESULT_MSG}</span>
        </div>
      </div>
    </div>
  );
}
