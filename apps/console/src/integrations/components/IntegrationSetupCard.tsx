// Shared "one-click integration" setup scaffold.
//
// Every integration page answers the same three questions in the same
// order — "what is this / what do I need / what do I click" — so the
// surface reads consistently across GitHub, Slack, Linear and Telegram.
// This component only renders that scaffold; the provider-specific action
// (a wizard link, a form, a Connect button) is passed as `children`.
//
// Presentational only: no data fetching. Callers derive `status` from
// their own `list*` endpoints (or a static value for deployment-level
// providers like Telegram) and pass copy-paste commands / deep-links into
// the numbered steps.

import { useState, type ReactNode } from "react";

export type SetupStatus = "connected" | "needs-config" | "not-connected";

export interface SetupRequirement {
  /** Short name of the thing needed (a token, a secret, an app id…). */
  label: string;
  /** Optional one-line clarification of where it comes from. */
  detail?: ReactNode;
  /** Mark optional prerequisites so users know what they can skip. */
  optional?: boolean;
}

export interface SetupStep {
  title: ReactNode;
  body?: ReactNode;
}

interface IntegrationSetupCardProps {
  /** Provider display name — e.g. "Telegram". */
  name: string;
  /** "What is this" — one or two sentences, plain language. */
  whatIsThis: ReactNode;
  status: SetupStatus;
  /** Short badge detail, e.g. "2 connected" or "Deployment-level". */
  statusDetail?: ReactNode;
  /** "What do I need" — the exact fields / secrets / prerequisites. */
  requirements: SetupRequirement[];
  /** "What do I click" — numbered, in order. */
  steps: SetupStep[];
  /** Provider action (Connect button, wizard link, form…). */
  children?: ReactNode;
  /** Start the steps collapsed (used when embedding as an explainer above
   *  an existing list page). Defaults to expanded on standalone pages. */
  collapsibleSteps?: boolean;
}

const STATUS_BADGE: Record<SetupStatus, { label: string; cls: string; dot: string }> = {
  connected: {
    label: "Connected",
    cls: "text-success bg-success-subtle",
    dot: "bg-success",
  },
  "needs-config": {
    label: "Needs config",
    cls: "text-warning bg-warning-subtle",
    dot: "bg-warning",
  },
  "not-connected": {
    label: "Not connected",
    cls: "text-fg-subtle bg-bg-surface",
    dot: "bg-fg-subtle",
  },
};

export function IntegrationSetupCard({
  name,
  whatIsThis,
  status,
  statusDetail,
  requirements,
  steps,
  children,
  collapsibleSteps = false,
}: IntegrationSetupCardProps) {
  const badge = STATUS_BADGE[status];
  return (
    <div className="rounded-xl border border-border bg-bg-surface overflow-hidden">
      {/* What is this */}
      <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-border">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold text-fg">{name} setup</h2>
          <p className="mt-1 text-[13px] text-fg-muted max-w-xl">{whatIsThis}</p>
        </div>
        <span
          className={`shrink-0 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${badge.cls}`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${badge.dot}`} />
          {statusDetail ?? badge.label}
        </span>
      </div>

      {/* What do I need */}
      <div className="px-5 py-4 border-b border-border">
        <h3 className="text-[11px] font-medium text-fg-muted uppercase tracking-wider mb-2.5">
          What you need
        </h3>
        <ul className="space-y-1.5">
          {requirements.map((r, i) => (
            <li key={i} className="flex items-baseline gap-2 text-[13px]">
              <span className="shrink-0 mt-0.5 text-fg-subtle" aria-hidden="true">
                •
              </span>
              <span className="text-fg">
                <span className="font-medium">{r.label}</span>
                {r.optional && (
                  <span className="ml-1.5 text-[11px] text-fg-subtle uppercase tracking-wide">
                    optional
                  </span>
                )}
                {r.detail && <span className="text-fg-muted"> — {r.detail}</span>}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {/* What do I click */}
      <SetupSteps steps={steps} collapsible={collapsibleSteps} />

      {children && <div className="px-5 py-4 border-t border-border bg-bg/40">{children}</div>}
    </div>
  );
}

function SetupSteps({ steps, collapsible }: { steps: SetupStep[]; collapsible: boolean }) {
  const [open, setOpen] = useState(!collapsible);
  return (
    <div className="px-5 py-4">
      <button
        type="button"
        onClick={collapsible ? () => setOpen((v) => !v) : undefined}
        className={`flex items-center gap-1.5 text-[11px] font-medium text-fg-muted uppercase tracking-wider ${
          collapsible ? "hover:text-fg cursor-pointer" : "cursor-default"
        }`}
        aria-expanded={open}
      >
        Step-by-step
        {collapsible && (
          <span className="text-fg-subtle normal-case tracking-normal">
            {open ? "▾" : "▸"}
          </span>
        )}
      </button>
      {open && (
        <ol className="mt-3 space-y-3.5">
          {steps.map((s, i) => (
            <li key={i} className="flex gap-3">
              <span className="shrink-0 flex items-center justify-center w-6 h-6 rounded-full bg-brand/10 text-brand text-[12px] font-semibold tabular-nums">
                {i + 1}
              </span>
              <div className="min-w-0 flex-1 pt-0.5">
                <p className="text-[13px] font-medium text-fg">{s.title}</p>
                {s.body && <div className="mt-1.5 text-[13px] text-fg-muted">{s.body}</div>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/**
 * Copy-paste command / value block with a copy button. Used inside step
 * bodies for shell commands, secret names, and webhook URLs so users can
 * grab the exact string without transcription errors.
 */
export function CopyableCommand({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked (insecure origin / permissions) — the
      // value is still visible and selectable, so fail quietly.
    }
  }
  return (
    <div className="mt-2 group relative rounded-md border border-border bg-bg font-mono text-[12px] text-fg">
      {label && (
        <div className="px-3 pt-2 text-[10px] uppercase tracking-wider text-fg-subtle font-sans">
          {label}
        </div>
      )}
      <div className="flex items-start gap-2 px-3 py-2">
        <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre">{value}</pre>
        <button
          type="button"
          onClick={copy}
          className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-sans text-fg-muted hover:text-fg hover:bg-bg-surface transition-colors"
          title="Copy to clipboard"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
