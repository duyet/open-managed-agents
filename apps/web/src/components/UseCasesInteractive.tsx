import { useEffect, useRef, useState } from "react";

/**
 * Interactive "Built for Real Workflows" panel.
 *
 * Three selectable use cases, each with a small animated visual that plays
 * its lines in sequence (terminal deploy trace, multi-channel chat thread,
 * durable event-log replay). Tabs auto-advance until the visitor interacts,
 * then stay put. Reduced-motion users get every line rendered statically.
 *
 * Theme-aware: colors come from the site's CSS custom properties.
 */

type Accent = "orange" | "blue" | "green";

interface Line {
  /** Left gutter tag (prompt, badge, event index). */
  tag: string;
  text: string;
  /** Optional emphasis color for the line. */
  accent?: Accent;
}

interface UseCase {
  id: string;
  title: string;
  blurb: string;
  accent: Accent;
  visualTitle: string;
  lines: Line[];
}

const CASES: UseCase[] = [
  {
    id: "deploy",
    title: "Deploy & Operate",
    blurb:
      "Kubernetes-native with health checks and metrics. Run on Cloudflare or your own cluster — same code, same API.",
    accent: "green",
    visualTitle: "oma://deploy — production rollout",
    lines: [
      { tag: "$", text: "helm install oma ./charts/oma-k8s-bridge" },
      { tag: "$", text: "kubectl -n sandboxes get pods" },
      { tag: "ok", text: "oma-k8s-bridge-7d4f...   1/1  Running", accent: "green" },
      { tag: "$", text: "curl -s $BASE/api/v1/health" },
      { tag: "200", text: '{"status":"ok","provider":"k8s-bridge"}', accent: "green" },
      { tag: "$", text: "oma envs create -f k8s.json  # fleet ready", accent: "blue" },
    ],
  },
  {
    id: "channels",
    title: "Multi-Channel",
    blurb:
      "Slack, Telegram, Linear — agents as real teammates with their own identity: @mentionable, assignable, threaded.",
    accent: "blue",
    visualTitle: "#eng-platform — Slack thread",
    lines: [
      { tag: "you", text: "@oma investigate the flaky checkout test", accent: "blue" },
      { tag: "oma", text: "⏳ session sess_9f2 started · reading CI logs…" },
      { tag: "oma", text: "⚙ bash · pnpm vitest run checkout.test.ts" },
      { tag: "oma", text: "✓ Root cause: unawaited fetch in test setup", accent: "green" },
      { tag: "oma", text: "↳ replied in thread · PR #214 opened", accent: "green" },
      { tag: "tg", text: "same agent, same session — now from Telegram", accent: "orange" },
    ],
  },
  {
    id: "state",
    title: "Managed State",
    blurb:
      "Crashes? Sessions resume from the last event. Append-only SQLite log means no data loss, no partial turns.",
    accent: "orange",
    visualTitle: "sess_9f2 — append-only event log",
    lines: [
      { tag: "017", text: "user.message         · persisted → broadcast" },
      { tag: "018", text: "agent.tool_use       · bash · pnpm test" },
      { tag: "019", text: "agent.tool_result    · exit 0", accent: "green" },
      { tag: "✗", text: "container crashed mid-turn", accent: "orange" },
      { tag: "020", text: "session.error        · retryable — log intact" },
      { tag: "021", text: "resume: harness rebuilds context from 001…020", accent: "green" },
    ],
  },
];

export default function UseCasesInteractive() {
  const reduceMotion =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  const [active, setActive] = useState(0);
  const [shown, setShown] = useState(reduceMotion ? CASES[0].lines.length : 0);
  const [pinned, setPinned] = useState(false); // stop auto-advance after interaction
  const timer = useRef<number | null>(null);

  // Reveal lines one by one; when a case finishes (and nobody interacted),
  // advance to the next case.
  useEffect(() => {
    if (reduceMotion) {
      setShown(CASES[active].lines.length);
      return;
    }
    setShown(0);
    const total = CASES[active].lines.length;
    let i = 0;
    timer.current = window.setInterval(() => {
      i += 1;
      setShown(i);
      if (i >= total) {
        if (timer.current) window.clearInterval(timer.current);
        if (!pinned) {
          timer.current = window.setTimeout(() => {
            setActive((a) => (a + 1) % CASES.length);
          }, 2200) as unknown as number;
        }
      }
    }, 550);
    return () => {
      if (timer.current) {
        window.clearInterval(timer.current);
        window.clearTimeout(timer.current);
      }
    };
  }, [active, pinned, reduceMotion]);

  const select = (i: number) => {
    setPinned(true);
    setActive(i);
  };

  const c = CASES[active];

  return (
    <div className="usecases-grid">
      {/* Tab rail */}
      <div className="usecases-tabs" role="tablist" aria-label="Use cases">
        {CASES.map((uc, i) => (
          <button
            key={uc.id}
            role="tab"
            aria-selected={i === active}
            className={`usecase-tab uc-${uc.accent}${i === active ? " is-active" : ""}`}
            onClick={() => select(i)}
          >
            <span className="usecase-tab-title">{uc.title}</span>
            <span className="usecase-tab-blurb">{uc.blurb}</span>
            {i === active && !reduceMotion && (
              <span
                className="usecase-progress"
                key={`${uc.id}-${shown === 0 ? "r" : "p"}`}
                style={{ width: `${(shown / uc.lines.length) * 100}%` }}
                aria-hidden="true"
              />
            )}
          </button>
        ))}
      </div>

      {/* Visual panel */}
      <figure className={`usecase-visual uc-${c.accent}`} role="tabpanel" aria-label={c.title}>
        <figcaption className="usecase-visual-bar">
          <span className="terminal-dot" aria-hidden="true"></span>
          <span className="terminal-dot" aria-hidden="true"></span>
          <span className="terminal-dot" aria-hidden="true"></span>
          <span className="usecase-visual-title">{c.visualTitle}</span>
        </figcaption>
        <div className="usecase-visual-body font-mono" aria-live="polite">
          {c.lines.map((l, i) => (
            <p
              key={`${c.id}-${i}`}
              className={`usecase-line${i < shown ? " is-shown" : ""}${
                l.accent ? ` ucl-${l.accent}` : ""
              }`}
            >
              <span className="usecase-line-tag">{l.tag}</span>
              <span>{l.text}</span>
            </p>
          ))}
        </div>
      </figure>
    </div>
  );
}
