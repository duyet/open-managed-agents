// "How it fits together" — numbered setup-steps grid. One panel that is BOTH
// the conceptual map and the setup tracker: three numbered step-columns
// ordered by real setup dependency (① Foundation → ② Agent → ③ Reach).
// Each card's title is a component TYPE, its body the actual created
// instances as badges, and each step header earns a checkmark when its
// required cards are satisfied — so an empty/grey card *is* the to-do item
// and no separate checklist is needed.
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { useApiQuery } from "../lib/useApiQuery";
import { IntegrationsApi } from "../integrations/api/client";
import { friendlyHostingDescription } from "../lib/hostingTypes";
import {
  AgentIcon,
  ModelCardsIcon,
  SkillsIcon,
  EnvIcon,
  VaultIcon,
  RuntimesIcon,
} from "./icons";
import { PlugIcon, MessageCircleIcon, GlobeIcon, CheckIcon } from "lucide-react";

interface AgentRecord {
  id: string;
  name: string;
}
interface ModelCard {
  id: string;
  model_id: string;
}
interface McpServerEntry {
  id: string;
  name: string;
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
      aria-label={`${card.title} — ${empty ? "not set up yet" : card.badges.join(", ")}`}
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
          : "border-border bg-bg hover:border-border-strong hover:bg-bg-surface/40",
      )}
    >
      <div className="flex items-center gap-2">
        <span className="text-fg-subtle shrink-0">{card.icon}</span>
        <span className="text-[13px] font-medium text-fg flex-1 min-w-0 truncate">
          {card.title}
        </span>
        <StatusDot status={card.status} />
      </div>
      {empty ? (
        <div className="mt-1 text-[11px] leading-snug text-fg-muted">
          {card.emptyCta}
        </div>
      ) : (
        <InstanceBadges names={card.badges} />
      )}
    </div>
  );
}

interface Step {
  number: string;
  name: string;
  optional?: boolean;
  done: boolean;
  cards: TypeCard[];
}

function StepBadge({ step }: { step: Step }) {
  if (step.done) {
    return (
      <span
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-success/15 text-success"
        aria-label="complete"
      >
        <CheckIcon className="h-3.5 w-3.5" strokeWidth={2.5} />
      </span>
    );
  }
  return (
    <span
      className={cn(
        "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[12px] font-semibold",
        step.optional
          ? "border-dashed border-border text-fg-subtle"
          : "border-border-strong text-fg-muted",
      )}
      aria-label={step.optional ? "optional" : "not complete"}
    >
      {step.number}
    </span>
  );
}

function StepColumn({ step, nav }: { step: Step; nav: (to: string) => void }) {
  return (
    <div className="flex min-w-0 flex-col">
      <div className="mb-2.5 flex items-center gap-2">
        <StepBadge step={step} />
        <span className="text-[13px] font-semibold text-fg">{step.name}</span>
        {step.optional && (
          <span className="rounded-full border border-border px-1.5 py-px text-[10px] uppercase tracking-[0.08em] text-fg-subtle">
            optional
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-2 border-l border-border/60 pl-3 md:border-l-0 md:pl-0">
        {step.cards.map((c) => (
          <TypeCardView key={c.key} card={c} nav={nav} />
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
  const mcpQ = useApiQuery<Page<McpServerEntry>>("/v1/mcp_servers", { limit: "10" });
  const skillsQ = useApiQuery<Page<SkillEntry>>("/v1/skills", { limit: "10" });
  const envQ = useApiQuery<Page<EnvEntry>>("/v1/environments", { limit: "10" });
  const vaultsQ = useApiQuery<Page<VaultEntry>>("/v1/vaults", { limit: "10" });
  const pubsQ = useApiQuery<Page<PublicationEntry>>("/v1/publications", { limit: "10" });

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
  const mcps = mcpQ.data?.data ?? [];
  const pubs = pubsQ.data?.data ?? [];
  const channels = chatQ.data ?? [];

  const envAttention = envs.some((e) => e.status === "building" || e.status === "error");
  const envStatus: CardStatus =
    envs.length === 0 ? "empty" : envAttention ? "attention" : "ready";
  const providers = [...new Set(envs.map(providerLabel))];

  const countStatus = (n: number): CardStatus => (n > 0 ? "ready" : "empty");

  const foundation: Step = {
    number: "1",
    name: "Foundation",
    done: modelCards.length > 0 && envStatus === "ready",
    cards: [
      {
        key: "model",
        icon: <ModelCardsIcon className="w-4 h-4" />,
        title: "Model card",
        to: "/model-cards",
        status: countStatus(modelCards.length),
        badges: modelCards.map((m) => m.model_id),
        emptyCta: "+ Add a model card — the AI brain",
      },
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
        key: "runtime",
        icon: <RuntimesIcon className="w-4 h-4" />,
        title: "Sandbox runtime",
        to: "/runtimes",
        status: envStatus,
        badges: providers,
        emptyCta: "+ Where sandboxes run — set by your environment",
      },
      {
        key: "vaults",
        icon: <VaultIcon className="w-4 h-4" />,
        title: "Keys (Vault)",
        to: "/vaults",
        status: countStatus(vaults.length),
        badges: vaults.map((v) => v.name),
        emptyCta: "+ Store an API key or credential",
      },
    ],
  };

  const agentStep: Step = {
    number: "2",
    name: "Agent",
    done: agents.length > 0,
    cards: [
      {
        key: "agent",
        icon: <AgentIcon className="w-4 h-4 text-brand" />,
        title: "Agent",
        to: "/agents",
        status: countStatus(agents.length),
        badges: agents.map((a) => a.name),
        emptyCta: "+ Create your first agent",
      },
      {
        key: "skills",
        icon: <SkillsIcon className="w-4 h-4" />,
        title: "Skills",
        to: "/skills",
        status: countStatus(skills.length),
        badges: skills.map((s) => s.name),
        emptyCta: "+ Add a skill (prompts & know-how)",
      },
      {
        key: "mcp",
        icon: <PlugIcon className="w-4 h-4" />,
        title: "Connections (MCP)",
        to: "/agents",
        status: countStatus(mcps.length),
        badges: mcps.map((m) => m.name),
        emptyCta: "+ Connect a tool or API",
      },
    ],
  };

  const reach: Step = {
    number: "3",
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

  const steps = [foundation, agentStep, reach];
  const requiredDone = [foundation.done, agentStep.done].filter(Boolean).length;

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
      <p className="mt-1 mb-5 text-[13px] text-fg-muted">
        Set up the pieces in order — each step checks off as its required
        pieces turn green. Click any card to manage that piece.
      </p>

      <div className="grid grid-cols-1 gap-x-5 gap-y-6 md:grid-cols-2 lg:grid-cols-3">
        {steps.map((s) => (
          <StepColumn key={s.number} step={s} nav={nav} />
        ))}
      </div>
    </section>
  );
}
