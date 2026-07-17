// "How it fits together" — one panel that is BOTH the conceptual map and the
// setup tracker, drawn as a left-to-right flow so the *relations* between the
// pieces are the thing you read first:
//
//   1 · CONFIGURE  →  2 · COMPOSE  →  3 · RUN  →  4 · REACH
//   (the pieces)      (the agent)     (env+vaults  (channels &
//                                      ↓ session    publications)
//                                      ↓ sandbox)
//
// The flow mirrors the page's own header copy — "configure the pieces, compose
// them into an agent, and every conversation runs as a session inside a
// sandbox". Steps 1/2 are required; 3 is what happens once they're done; 4 is
// optional. Pointers between steps are plain divs (no SVG/diagram lib) so the
// whole thing reflows to a vertical stack on narrow screens.
//
// Each card's title is a component TYPE, its body the actual created
// instances as badges — an empty/dashed card *is* the to-do item, so nothing
// needs a second checklist. RUN's cards describe runtime behaviour rather
// than instances you create, so they carry a `description` instead.
import { Fragment, useState } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { useApiQuery } from "../lib/useApiQuery";
import { IntegrationsApi } from "../integrations/api/client";
import { friendlyHostingDescription } from "../lib/hostingTypes";
import { ProviderMark } from "./ProviderMark";
import {
  AgentIcon,
  ApiKeysIcon,
  FilesIcon,
  MemoryIcon,
  ModelCardsIcon,
  SessionsIcon,
  SkillsIcon,
  EnvIcon,
  VaultIcon,
  RuntimesIcon,
} from "./icons";
import {
  MessageCircleIcon,
  GlobeIcon,
  CheckIcon,
  ArrowRightIcon,
  ArrowDownIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
} from "lucide-react";

interface AgentRecord {
  id: string;
  name: string;
}
interface ModelCard {
  id: string;
  model_id: string;
}
interface SkillEntry {
  id: string;
  name: string;
}
interface EnvEntry {
  id: string;
  name: string;
  config: Record<string, unknown>;
  status?: string;
}
interface VaultEntry {
  id: string;
  name: string;
}
interface PublicationEntry {
  id: string;
  title: string;
  status: "draft" | "live" | "paused";
}
interface ApiKeyEntry {
  id: string;
  name: string;
}
interface SessionEntry {
  id: string;
}
interface MemoryStoreEntry {
  id: string;
  name: string;
}
interface FileEntry {
  id: string;
  filename: string;
}
interface Page<T> {
  data: T[];
  next_cursor?: string;
}

type CardStatus = "ready" | "attention" | "empty";

function StatusDot({ status }: { status: CardStatus }) {
  return (
    <span
      className={cn(
        "shrink-0 w-2 h-2 rounded-full",
        status === "ready" && "bg-success",
        status === "attention" && "bg-warning",
        status === "empty" && "border border-border bg-transparent",
      )}
      aria-hidden="true"
    />
  );
}

interface TypeCard {
  key: string;
  icon: React.ReactNode;
  /** Component TYPE — "Model card", "Environment", … never an instance name. */
  title: string;
  to: string;
  status: CardStatus;
  /** Real instance names shown as badges (capped at 3 + "+N"). */
  badges: string[];
  emptyCta: string;
  /** Static explainer shown *instead of* badges. For pieces you don't
   *  create-and-name (a Session, the Sandbox) a list of instances is noise —
   *  what the piece DOES is the useful thing to say. */
  description?: string;
  /** The Agent — the thing you're actually building. Brand-accented and a
   *  size up, so the eye lands on step 2 first and reads outward. */
  hero?: boolean;
  /** Provider ids rendered as small monochrome brand marks under the
   *  description (the Sandbox card's "runs on" row). */
  providerMarks?: string[];
}

const BADGE_CAP = 3;

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

function TypeCardView({ card, nav }: { card: TypeCard; nav: (to: string) => void }) {
  const empty = card.status === "empty";
  return (
    <div
      role="link"
      tabIndex={0}
      aria-label={`${card.title} — ${
        card.description ?? (empty ? "not set up yet" : card.badges.join(", "))
      }`}
      onClick={() => nav(card.to)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          nav(card.to);
        }
      }}
      className={cn(
        "group relative w-full text-left rounded-md border px-3.5 py-3 cursor-pointer select-none",
        "active:translate-y-px transition-[color,background-color,border-color,transform,opacity] duration-[var(--dur-quick)] ease-[var(--ease-soft)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50",
        empty
          ? "border-dashed border-border bg-transparent opacity-70 hover:opacity-100 hover:border-border-strong"
          : card.hero
            ? "border-brand/50 bg-brand/5 hover:border-brand"
            : "border-border bg-bg hover:border-border-strong hover:bg-bg-surface/40",
      )}
    >
      <div className="flex items-center gap-2">
        <span className={cn("shrink-0", card.hero ? "text-brand" : "text-fg-subtle")}>
          {card.icon}
        </span>
        <span
          className={cn(
            "flex-1 min-w-0 truncate text-fg",
            card.hero ? "text-[15px] font-semibold" : "text-[13px] font-medium",
          )}
        >
          {card.title}
        </span>
        <StatusDot status={card.status} />
      </div>
      {card.description ? (
        <>
          <div className="mt-1 text-[11px] leading-snug text-fg-muted">
            {card.description}
          </div>
          {card.providerMarks && card.providerMarks.length > 0 && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {card.providerMarks.map((id) => (
                <ProviderMark key={id} id={id} className="size-3.5 text-fg-subtle" />
              ))}
            </div>
          )}
        </>
      ) : empty ? (
        <div className="mt-1 text-[11px] leading-snug text-fg-muted">
          {card.emptyCta}
        </div>
      ) : (
        <InstanceBadges names={card.badges} />
      )}
    </div>
  );
}

/** The composition rule, stated outright.
 *
 *  The flow below now mirrors both lines — Skills sits under the Agent in
 *  COMPOSE, and Env + Vaults sit above the Session in RUN — but the formula
 *  still earns its place: MCP belongs to the agent yet has no page of its
 *  own (so no card), and only the formula names every operand in one glance.
 *
 *  Kept as text, not cards: it's a definition, not a destination. */
function CompositionFormula() {
  const rows: Array<{ lhs: string; parts: string[] }> = [
    { lhs: "agent", parts: ["model", "skills", "mcp"] },
    { lhs: "session", parts: ["agent", "env", "vaults"] },
  ];
  return (
    <div className="mb-5 rounded-md border border-border bg-bg-surface/40 px-3.5 py-2.5">
      <div className="flex flex-col gap-1 font-mono text-[12px] leading-relaxed">
        {rows.map((r) => (
          <div
            key={r.lhs}
            data-testid={`formula-${r.lhs}`}
            className="flex items-baseline gap-1.5"
          >
            <span className="w-[3.75rem] shrink-0 font-semibold text-brand">
              {r.lhs}
            </span>
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

/** Mini pointer between steps — the thing that makes this read as a diagram
 *  rather than four unrelated columns. Horizontal on wide screens, vertical
 *  once the flow stacks. Decorative: the step numbers already carry the order
 *  for screen readers. */
function FlowPointer() {
  return (
    <div
      className="flex shrink-0 items-center justify-center self-center py-1 text-fg-subtle xl:py-0"
      aria-hidden="true"
    >
      <ArrowDownIcon className="h-3.5 w-3.5 xl:hidden" />
      <ArrowRightIcon className="hidden h-3.5 w-3.5 xl:block" />
    </div>
  );
}

/** A step's contents, top to bottom. A nested array is one ROW — cards that
 *  sit side by side because they're peers of each other (Environment + Vaults
 *  both feed the session below them). */
type StepRow = TypeCard | TypeCard[];

interface Step {
  number: string;
  name: string;
  optional?: boolean;
  done: boolean;
  cards: StepRow[];
  /** Vertically centre the cards — COMPOSE is shorter than CONFIGURE and
   *  would otherwise float at the top of a much taller column. */
  center?: boolean;
  /** Chain the cards with ↓ pointers instead of plain gaps. RUN is a
   *  sequence (a session runs *inside* a sandbox), not an unordered set. */
  chain?: boolean;
  /** Extra width. COMPOSE carries the hero plus a two-up row, so an equal
   *  quarter-share would crush its titles. */
  wide?: boolean;
}

function StepHeader({ step, onCollapse }: { step: Step; onCollapse: () => void }) {
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
        <span
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-success/15 text-success"
          aria-label="complete"
        >
          <CheckIcon className="h-2.5 w-2.5" strokeWidth={3} />
        </span>
      )}
      {/* Collapse — desktop-only affordance; the stacked mobile layout has
          no horizontal space to reclaim, so the toggle hides there. */}
      <button
        type="button"
        onClick={onCollapse}
        aria-label={`Collapse ${step.name}`}
        className="ml-auto hidden h-5 w-5 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-bg-surface hover:text-fg xl:flex"
      >
        <ChevronsLeftIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

const rowKey = (row: StepRow) =>
  Array.isArray(row) ? row.map((c) => c.key).join("+") : row.key;

function StepPanel({ step, nav }: { step: Step; nav: (to: string) => void }) {
  // Every column can collapse to a slim vertical rail (desktop only) —
  // click to expand. Optional steps with nothing configured start
  // collapsed; everything else starts open.
  const [collapsed, setCollapsed] = useState(!!step.optional && !step.done);

  if (collapsed) {
    return (
      <>
        {/* Slim rail on xl — the stacked mobile layout renders the full
            panel below instead (no width to reclaim there). */}
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          aria-label={`Expand step ${step.number} — ${step.name}`}
          aria-expanded="false"
          className="hidden shrink-0 flex-col items-center gap-2 rounded-lg border border-dashed border-border/70 px-1.5 py-3 text-fg-subtle transition-colors hover:border-border-strong hover:text-fg xl:flex"
        >
          <ChevronsRightIcon className="h-3.5 w-3.5" />
          <span
            className="font-mono text-[10px] uppercase tracking-[0.12em]"
            style={{ writingMode: "vertical-rl" }}
          >
            {step.number} · {step.name}
          </span>
          {step.done && (
            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-success/15 text-success">
              <CheckIcon className="h-2.5 w-2.5" strokeWidth={3} />
            </span>
          )}
        </button>
        <div className="flex min-w-0 flex-1 xl:hidden">
          <ExpandedStepPanel step={step} nav={nav} onCollapse={() => setCollapsed(true)} />
        </div>
      </>
    );
  }

  return <ExpandedStepPanel step={step} nav={nav} onCollapse={() => setCollapsed(true)} />;
}

function ExpandedStepPanel({
  step,
  nav,
  onCollapse,
}: {
  step: Step;
  nav: (to: string) => void;
  onCollapse: () => void;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 flex-col rounded-lg border border-dashed border-border/70 p-3",
        step.wide && "xl:flex-[1.2]",
      )}
    >
      <StepHeader step={step} onCollapse={onCollapse} />
      <div
        className={cn(
          "flex flex-1 flex-col",
          step.chain ? "gap-0" : "gap-2",
          step.center && "justify-center",
        )}
      >
        {step.cards.map((row, i) => (
          <Fragment key={rowKey(row)}>
            {step.chain && i > 0 && (
              <div
                className="flex justify-center py-1 text-fg-subtle"
                aria-hidden="true"
              >
                <ArrowDownIcon className="h-3.5 w-3.5" />
              </div>
            )}
            {Array.isArray(row) ? (
              // flex-wrap + a per-card minimum: when the column is too
              // narrow for the pair, cards stack instead of truncating
              // titles down to one letter.
              <div className="flex flex-wrap items-stretch gap-2">
                {row.map((c) => (
                  <div key={c.key} className="flex min-w-[8.5rem] flex-1">
                    <TypeCardView card={c} nav={nav} />
                  </div>
                ))}
              </div>
            ) : (
              <TypeCardView card={row} nav={nav} />
            )}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function providerLabel(env: EnvEntry): string {
  const id =
    (env.config?.sandbox_provider as string | undefined) ??
    (env.config?.type as string | undefined) ??
    "cloud";
  const desc = friendlyHostingDescription({ id, label: id });
  return desc?.split(" — ")[0] ?? id;
}

export function StackedAssembly() {
  const nav = useNavigate();

  const agentsQ = useApiQuery<Page<AgentRecord>>("/v1/agents", { limit: "10" });
  const modelCardsQ = useApiQuery<Page<ModelCard>>("/v1/model_cards", { limit: "10" });
  const skillsQ = useApiQuery<Page<SkillEntry>>("/v1/skills", { limit: "10" });
  const envQ = useApiQuery<Page<EnvEntry>>("/v1/environments", { limit: "10" });
  const vaultsQ = useApiQuery<Page<VaultEntry>>("/v1/vaults", { limit: "10" });
  const pubsQ = useApiQuery<Page<PublicationEntry>>("/v1/publications", { limit: "10" });
  const apiKeysQ = useApiQuery<Page<ApiKeyEntry>>("/v1/api_keys", { limit: "10" });
  const sessionsQ = useApiQuery<Page<SessionEntry>>("/v1/sessions", { limit: "10" });
  const memoryQ = useApiQuery<Page<MemoryStoreEntry>>("/v1/memory_stores", { limit: "10" });
  const filesQ = useApiQuery<Page<FileEntry>>("/v1/files", { limit: "10" });

  // Channels: reuse the same live-installation counts the Integrations Hub
  // already computes (issue #92) rather than inventing a new endpoint.
  const chatQ = useQuery({
    queryKey: ["dashboard-integration-counts"],
    queryFn: async () => {
      const integrations = new IntegrationsApi();
      const [linear, github, slack] = await Promise.all([
        integrations.linear.listInstallations().catch(() => []),
        integrations.github.listInstallations().catch(() => []),
        integrations.slack.listInstallations().catch(() => []),
      ]);
      return [
        ...linear.map(() => "Linear"),
        ...github.map(() => "GitHub"),
        ...slack.map(() => "Slack"),
      ];
    },
    staleTime: 30_000,
  });

  const agents = agentsQ.data?.data ?? [];
  const modelCards = modelCardsQ.data?.data ?? [];
  const envs = envQ.data?.data ?? [];
  const vaults = vaultsQ.data?.data ?? [];
  const skills = skillsQ.data?.data ?? [];
  const pubs = pubsQ.data?.data ?? [];
  const channels = chatQ.data ?? [];
  const apiKeys = apiKeysQ.data?.data ?? [];
  const sessions = sessionsQ.data?.data ?? [];
  const memoryStores = memoryQ.data?.data ?? [];
  const files = filesQ.data?.data ?? [];

  const envAttention = envs.some((e) => e.status === "building" || e.status === "error");
  const envStatus: CardStatus =
    envs.length === 0 ? "empty" : envAttention ? "attention" : "ready";
  const providers = [...new Set(envs.map(providerLabel))];
  const providerIds = [
    ...new Set(
      envs.map(
        (e) =>
          (e.config?.sandbox_provider as string | undefined) ??
          (e.config?.type as string | undefined) ??
          "cloud",
      ),
    ),
  ];

  const countStatus = (n: number): CardStatus => (n > 0 ? "ready" : "empty");

  const agentReady = agents.length > 0;

  const configure: Step = {
    number: "1",
    name: "Configure",
    done: modelCards.length > 0,
    cards: [
      {
        key: "api-key",
        icon: <ApiKeysIcon className="w-4 h-4" />,
        title: "API key",
        to: "/api-keys",
        status: countStatus(apiKeys.length),
        badges: apiKeys.map((k) => k.name),
        emptyCta: "+ Auth for the CLI & your agent",
      },
      {
        key: "model",
        icon: <ModelCardsIcon className="w-4 h-4" />,
        title: "Model card",
        to: "/model-cards",
        status: countStatus(modelCards.length),
        badges: modelCards.map((m) => m.model_id),
        emptyCta: "+ Add a model card — the AI brain",
      },
    ],
  };

  const compose: Step = {
    number: "2",
    name: "Compose",
    done: agentReady,
    center: true,
    wide: true,
    cards: [
      {
        key: "agent",
        hero: true,
        icon: <AgentIcon className="w-5 h-5" />,
        title: "Agent",
        to: agentReady ? "/agents" : "/agents/new",
        status: agentReady ? "ready" : "empty",
        badges: agents.map((a) => a.name),
        emptyCta: "+ Create your first agent — it composes everything in step 1",
      },
      // Skills is the only piece of `agent = model + skills + mcp` that is
      // also a resource with its own page, so it's the only one that earns a
      // card inside the agent's box. Model lives in step 1 (you create a model
      // card), and MCP has no page at all — it's a tab inside the agent form,
      // so a card for it would link back to the very agent above it. The
      // formula states both relations instead.
      {
        key: "skills",
        icon: <SkillsIcon className="w-4 h-4" />,
        title: "Skills",
        to: "/skills",
        status: countStatus(skills.length),
        badges: skills.map((s) => s.name),
        emptyCta: "+ Prompts & know-how",
      },
      // Optional knowledge + data the agent works with — grouped with the
      // agent it augments; sessions mount them at runtime.
      [
        {
          key: "memory",
          icon: <MemoryIcon className="w-4 h-4" />,
          title: "Memory",
          to: "/memory",
          status: countStatus(memoryStores.length),
          badges: memoryStores.map((m) => m.name),
          emptyCta: "+ Notes it keeps",
        },
        {
          key: "files",
          icon: <FilesIcon className="w-4 h-4" />,
          title: "Files",
          to: "/files",
          status: countStatus(files.length),
          badges: files.map((f) => f.filename),
          emptyCta: "+ Data to mount",
        },
      ],
    ],
  };

  const run: Step = {
    number: "3",
    name: "Run",
    done: sessions.length > 0,
    chain: true,
    cards: [
      // `session = agent + env + vaults` — the agent arrives from step 2's
      // pointer; env + vaults are the session-scoped pieces, so they sit
      // here as the chain's inputs, mirroring Skills-under-Agent in COMPOSE.
      [
        {
          key: "env",
          icon: <EnvIcon className="w-4 h-4" />,
          title: "Environment",
          to: "/environments",
          status: envStatus,
          badges: envs.map((e) => e.name),
          emptyCta: "+ Create a sandbox environment",
        },
        {
          key: "vaults",
          icon: <VaultIcon className="w-4 h-4" />,
          title: "Keys (Vault)",
          to: "/vaults",
          status: countStatus(vaults.length),
          badges: vaults.map((v) => v.name),
          emptyCta: "+ Secrets it calls out with",
        },
      ],
      {
        key: "session",
        icon: <SessionsIcon className="w-4 h-4" />,
        title: "Session",
        to: "/sessions",
        status: countStatus(sessions.length),
        badges: [],
        emptyCta: "",
        description:
          "One conversation or task — streamed, resumable event log.",
      },
      {
        key: "runtime",
        icon: <RuntimesIcon className="w-4 h-4" />,
        title: "Sandbox",
        to: "/runtimes",
        status: envStatus,
        badges: providers,
        emptyCta: "+ Where sandboxes run — set by your environment",
        description:
          providers.length > 0
            ? `Runs on ${providers.join(", ")} — set by your environment.`
            : undefined,
        providerMarks: providerIds,
      },
    ],
  };

  const reach: Step = {
    number: "4",
    name: "Reach",
    optional: true,
    done: channels.length > 0 || pubs.length > 0,
    cards: [
      {
        key: "channels",
        icon: <MessageCircleIcon className="w-4 h-4" />,
        title: "Channels",
        to: "/integrations",
        status: countStatus(channels.length),
        badges: channels,
        emptyCta: "+ Connect Telegram, Slack, or GitHub",
      },
      {
        key: "publications",
        icon: <GlobeIcon className="w-4 h-4" />,
        title: "Publications",
        to: "/my-bots",
        status: countStatus(pubs.length),
        badges: pubs.map((p) => p.title),
        emptyCta: "+ Publish a public chat page or widget",
      },
    ],
  };

  const steps = [configure, compose, run, reach];
  const requiredDone = [configure.done, agentReady].filter(Boolean).length;

  return (
    <section className="border border-border rounded-lg p-5 md:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="font-display text-lg font-semibold text-fg">
          How it fits together
        </h2>
        <span className="text-[12px] tabular-nums text-fg-subtle">
          {requiredDone} of 2 required steps complete
        </span>
      </div>
      <p className="mt-1 mb-3 text-[13px] text-fg-muted">
        Configure the pieces, compose them into an agent, and every conversation
        runs as a session inside a sandbox. Reach is optional. Click any card to
        manage that piece.
      </p>

      <CompositionFormula />

      {/* The flow. Pointers sit between panels as their own flex children, so
          the row reflows to a vertical stack (with ↓ pointers) under lg. */}
      <div className="flex flex-col xl:flex-row xl:items-stretch">
        {steps.map((s, i) => (
          <Fragment key={s.number}>
            {i > 0 && <FlowPointer />}
            <StepPanel step={s} nav={nav} />
          </Fragment>
        ))}
      </div>
    </section>
  );
}
