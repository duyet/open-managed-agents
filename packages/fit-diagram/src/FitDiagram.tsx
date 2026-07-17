// Shared "How it fits together" diagram — presentational, host-agnostic.
// Used by both the Console dashboard (apps/console/src/components/StackedAssembly.tsx,
// live data + navigation + capacity-accordion collapse) and the landing page
// (apps/web/src/components/HowItFits.tsx, static demo data + click-to-describe
// dialog). Neither host's data-fetching or navigation logic lives here — only
// the layout, the card chrome, and (opt-in via `collapsible`) the
// ResizeObserver-driven column-collapse behavior moved over from Console.
//
// Styling: plain Tailwind utility classes against the `--color-*` theme
// tokens (bg-bg, text-fg, border-border, …). Both apps' Tailwind v4 `@theme`
// blocks define the same token names (see apps/console/src/index.css and
// apps/web/src/styles/global.css), so the classes below resolve to the
// correct value on either host without a mapping layer. Web's theme didn't
// define --color-success/--color-warning; added minimal entries there for
// the status dot (see apps/web/src/styles/global.css).
import { Fragment, useState } from "react";
import { ArrowDownIcon, ArrowRightIcon, CheckIcon, ChevronsLeftIcon, ChevronsRightIcon } from "lucide-react";
import { cn } from "./cn";
import { ProviderMark } from "./ProviderMark";
import type { FitCard, FitFormulaRow, FitRow, FitStep } from "./types";

const BADGE_CAP = 3;

function StatusDot({ status, dashed }: { status?: FitCard["status"]; dashed?: boolean }) {
  const empty = status === "empty" || (dashed && !status);
  return (
    <span
      className={cn(
        "shrink-0 w-2 h-2 rounded-full",
        !empty && status === "ready" && "bg-success",
        !empty && status === "attention" && "bg-warning",
        !empty && !status && "bg-success",
        empty && "border border-border bg-transparent",
      )}
      aria-hidden="true"
    />
  );
}

function InstanceBadges({ names }: { names: string[] }) {
  const shown = names.slice(0, BADGE_CAP);
  const rest = names.length - shown.length;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {shown.map((n) => (
        <span
          key={n}
          className="inline-flex max-w-[9.5rem] truncate rounded-[4px] border border-border bg-bg-surface/60 px-1.5 py-0.5 text-[11px] leading-tight text-fg-muted"
        >
          {n}
        </span>
      ))}
      {rest > 0 && (
        <span className="inline-flex rounded-[4px] px-1 py-0.5 text-[11px] leading-tight text-fg-subtle">
          +{rest}
        </span>
      )}
    </div>
  );
}

function ProviderMarkGroup({ ids }: { ids: string[] }) {
  return (
    <div className="mt-2 flex items-center -space-x-1.5">
      {ids.slice(0, 5).map((id) => (
        <span
          key={id}
          title={id}
          className="flex size-6 items-center justify-center rounded-full border border-border bg-bg-surface ring-2 ring-bg"
        >
          <ProviderMark id={id} className="size-3.5 text-fg-muted" />
        </span>
      ))}
      {ids.length > 5 && (
        <span className="flex size-6 items-center justify-center rounded-full border border-border bg-bg-surface ring-2 ring-bg text-[10px] font-medium text-fg-muted">
          +{ids.length - 5}
        </span>
      )}
    </div>
  );
}

function FitCardView({ card }: { card: FitCard }) {
  const empty = card.status === "empty";
  const badges = card.badges ?? [];
  return (
    <button
      type="button"
      aria-label={
        card.description
          ? `What is ${card.title}?`
          : `${card.title} — ${empty ? "not set up yet" : badges.join(", ")}`
      }
      aria-haspopup={card.description ? "dialog" : undefined}
      onClick={card.onActivate}
      className={cn(
        "group relative w-full text-left rounded-md border px-3.5 py-3 cursor-pointer select-none",
        "active:translate-y-px transition-[color,background-color,border-color,transform,opacity] duration-[var(--dur-quick)] ease-[var(--ease-soft)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50",
        card.dashed || empty
          ? "border-dashed border-border bg-transparent opacity-70 hover:opacity-100 hover:border-border-strong"
          : card.hero
            ? "border-brand/50 bg-brand/5 hover:border-brand"
            : "border-border bg-bg hover:border-border-strong hover:bg-bg-surface/40",
      )}
    >
      <div className="flex items-center gap-2">
        {card.icon && (
          <span className={cn("shrink-0", card.hero ? "text-brand" : "text-fg-subtle")}>
            {card.icon}
          </span>
        )}
        <span
          className={cn(
            "flex-1 min-w-0 truncate text-fg",
            card.hero ? "text-[15px] font-semibold" : "text-[13px] font-medium",
          )}
        >
          {card.title}
        </span>
        <StatusDot status={card.status} dashed={card.dashed} />
      </div>
      {card.note && <div className="mt-1 text-[11px] leading-snug text-fg-muted">{card.note}</div>}
      {!card.note && card.description && !card.badges ? (
        <div className="mt-1 text-[11px] leading-snug text-fg-muted">{card.description}</div>
      ) : empty && card.emptyCta ? (
        <div className="mt-1 text-[11px] leading-snug text-fg-muted">{card.emptyCta}</div>
      ) : badges.length > 0 ? (
        <InstanceBadges names={badges} />
      ) : null}
      {card.providerMarks && card.providerMarks.length > 0 && (
        <ProviderMarkGroup ids={card.providerMarks} />
      )}
    </button>
  );
}

/** The `agent = model + skills + mcp` composition rule, stated outright. */
export function FitFormula({ rows }: { rows: FitFormulaRow[] }) {
  return (
    <div className="mb-5 rounded-md border border-border bg-bg-surface/40 px-3.5 py-2.5">
      <div className="flex flex-col gap-1 font-mono text-[12px] leading-relaxed">
        {rows.map((r) => (
          <div key={r.lhs} data-testid={`formula-${r.lhs}`} className="flex items-baseline gap-1.5">
            <span className="w-[3.75rem] shrink-0 font-semibold text-brand">{r.lhs}</span>
            <span className="text-fg-subtle">=</span>
            <span className="text-fg-muted">
              {r.parts.map((p, i) => (
                <Fragment key={p}>
                  {i > 0 && <span className="text-fg-subtle"> + </span>}
                  <span className="text-fg">{p}</span>
                </Fragment>
              ))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function FlowPointer() {
  return (
    <div className="flex shrink-0 items-center justify-center self-center py-1 text-fg-subtle xl:py-0" aria-hidden="true">
      <ArrowDownIcon className="h-3.5 w-3.5 xl:hidden" />
      <ArrowRightIcon className="hidden h-3.5 w-3.5 xl:block" />
    </div>
  );
}

const rowKey = (row: FitRow) => (Array.isArray(row) ? row.map((c) => c.key).join("+") : row.key);

function StepHeader({ step, onCollapse }: { step: FitStep; onCollapse?: () => void }) {
  return (
    <div className="mb-2.5 flex items-center gap-1.5">
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-fg-subtle">
        {step.number} · {step.name}
      </span>
      {step.optional && (
        <span className="rounded-full border border-border px-1.5 py-px text-[9px] uppercase tracking-[0.08em] text-fg-subtle">
          optional
        </span>
      )}
      {step.done && (
        <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-success/15 text-success" aria-label="complete">
          <CheckIcon className="h-2.5 w-2.5" strokeWidth={3} />
        </span>
      )}
      {onCollapse && (
        <button
          type="button"
          onClick={onCollapse}
          aria-label={`Collapse ${step.name}`}
          className="ml-auto hidden h-5 w-5 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-bg-surface hover:text-fg xl:flex"
        >
          <ChevronsLeftIcon className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

function ExpandedStepPanel({ step, onCollapse }: { step: FitStep; onCollapse?: () => void }) {
  return (
    <div className={cn("flex min-w-0 flex-1 flex-col rounded-lg border border-dashed border-border/70 p-3", step.wide && "xl:flex-[1.2]")}>
      <StepHeader step={step} onCollapse={onCollapse} />
      <div className={cn("flex flex-1 flex-col", step.chain ? "gap-0" : "gap-2", step.center && "justify-center")}>
        {step.cards.map((row, i) => (
          <Fragment key={rowKey(row)}>
            {step.chain && i > 0 && (
              <div className="flex items-center justify-center gap-1.5 py-1 text-fg-subtle" aria-hidden="true">
                <ArrowDownIcon className="h-3.5 w-3.5" />
                {step.chainLabels?.[i - 1] && <span className="font-mono text-[10px]">{step.chainLabels[i - 1]}</span>}
              </div>
            )}
            {Array.isArray(row) ? (
              <div className="flex flex-wrap items-stretch gap-2">
                {row.map((c) => (
                  <div key={c.key} className="flex min-w-[8.5rem] flex-1">
                    <FitCardView card={c} />
                  </div>
                ))}
              </div>
            ) : (
              <FitCardView card={row} />
            )}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function StepPanel({
  step,
  collapsed,
  onToggle,
}: {
  step: FitStep;
  collapsed: boolean;
  onToggle: (expand: boolean) => void;
}) {
  if (!collapsed) return <ExpandedStepPanel step={step} onCollapse={() => onToggle(false)} />;
  return (
    <>
      <button
        type="button"
        onClick={() => onToggle(true)}
        aria-label={`Expand step ${step.number} — ${step.name}`}
        aria-expanded="false"
        className="hidden shrink-0 flex-col items-center gap-2 rounded-lg border border-dashed border-border/70 px-1.5 py-3 text-fg-subtle transition-colors hover:border-border-strong hover:text-fg xl:flex"
      >
        <ChevronsRightIcon className="h-3.5 w-3.5" />
        <span className="font-mono text-[10px] uppercase tracking-[0.12em]" style={{ writingMode: "vertical-rl" }}>
          {step.number} · {step.name}
        </span>
        {step.done && (
          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-success/15 text-success">
            <CheckIcon className="h-2.5 w-2.5" strokeWidth={3} />
          </span>
        )}
      </button>
      <div className="flex min-w-0 flex-1 xl:hidden">
        <ExpandedStepPanel step={step} onCollapse={() => onToggle(false)} />
      </div>
    </>
  );
}

const MIN_COL = 250;
const RAIL = 60; // rail width + pointer

/** Capacity-accordion collapse: expanded columns need ~MIN_COL px each; when
 *  the measured row can't fit all steps, the lowest-priority columns
 *  collapse to rails. A user click is an override — expanding a rail when
 *  the row is full evicts the least-recently-wanted expanded column. */
function useCapacityAccordion(steps: FitStep[]) {
  const [rowWidth, setRowWidth] = useState<number | null>(null);
  const rowRef = (el: HTMLDivElement | null) => {
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      setRowWidth(entries[0]?.contentRect.width ?? null);
    });
    ro.observe(el);
  };
  const [intent, setIntent] = useState<string[]>([]);

  const capacity = (() => {
    if (rowWidth == null) return steps.length; // unmeasured (SSR/jsdom): no auto-collapse
    for (let open = steps.length; open >= 1; open--) {
      if (open * MIN_COL + (steps.length - open) * RAIL <= rowWidth) return open;
    }
    return 1;
  })();

  const expandedSet = (() => {
    const userExpanded = intent.filter((n) => !n.startsWith("!"));
    const userCollapsed = new Set(intent.filter((n) => n.startsWith("!")).map((n) => n.slice(1)));
    const basePriority = steps
      .filter((s) => !(s.optional && !s.done))
      .sort((a, b) => Number(a.number === "1" || a.number === "4") - Number(b.number === "1" || b.number === "4"))
      .map((s) => s.number);
    const ordered = [
      ...userExpanded,
      ...basePriority.filter((n) => !userExpanded.includes(n) && !userCollapsed.has(n)),
    ];
    return new Set(ordered.slice(0, capacity));
  })();

  const toggleStep = (num: string, expand: boolean) => {
    setIntent((prev) => {
      const rest = prev.filter((n) => n !== num && n !== `!${num}`);
      return expand ? [num, ...rest] : [`!${num}`, ...rest];
    });
  };

  return { rowRef, expandedSet, toggleStep };
}

export interface FitDiagramProps {
  steps: FitStep[];
  /** Renders the `agent = model + skills + mcp` box above the flow. */
  formula?: FitFormulaRow[];
  /** Opt into the ResizeObserver-driven capacity-accordion column collapse
   *  (Console dashboard). The static demo surface leaves this off — its
   *  columns just wrap to a vertical stack under `xl`. */
  collapsible?: boolean;
  className?: string;
}

export function FitDiagram({ steps, formula, collapsible, className }: FitDiagramProps) {
  const { rowRef, expandedSet, toggleStep } = useCapacityAccordion(steps);
  return (
    <div className={className}>
      {formula && <FitFormula rows={formula} />}
      <div ref={collapsible ? rowRef : undefined} className="flex flex-col xl:flex-row xl:items-stretch">
        {steps.map((s, i) => (
          <Fragment key={s.number}>
            {i > 0 && <FlowPointer />}
            {collapsible ? (
              <StepPanel step={s} collapsed={!expandedSet.has(s.number)} onToggle={(expand) => toggleStep(s.number, expand)} />
            ) : (
              <ExpandedStepPanel step={s} />
            )}
          </Fragment>
        ))}
      </div>
    </div>
  );
}
