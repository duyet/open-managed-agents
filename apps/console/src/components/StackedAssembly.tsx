// "How it fits together" — stacked assembly. Non-technical framing: a hero
// Agent card on top, then a grid of building-block cards it "uses". Replaces
// the old three-stage arrow diagram AND the separate "Before your first
// session" checklist — an empty/grey block *is* the to-do item now, so
// nothing needs a second list.
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
} from "./icons";
import { PlugIcon, MessageCircleIcon } from "lucide-react";

interface AgentRecord {
  id: string;
  name: string;
  model: string | { id: string; speed?: string };
}
interface ModelCard {
  id: string;
  model_id: string;
  provider: string;
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
interface Page<T> {
  data: T[];
  next_cursor?: string;
}

type BlockStatus = "ready" | "attention" | "empty";

function StatusDot({ status }: { status: BlockStatus }) {
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

interface Block {
  key: string;
  icon: React.ReactNode;
  label: string;
  to: string;
  status: BlockStatus;
  summary: string;
  emptyCta: string;
}

function BlockCard({ block, nav }: { block: Block; nav: (to: string) => void }) {
  const empty = block.status === "empty";
  return (
    <div
      role="link"
      tabIndex={0}
      onClick={() => nav(block.to)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          nav(block.to);
        }
      }}
      className={cn(
        "group relative w-full text-left rounded-md border px-3.5 py-3 cursor-pointer select-none",
        "active:translate-y-px transition-[color,background-color,border-color,transform] duration-[var(--dur-quick)] ease-[var(--ease-soft)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50",
        empty
          ? "border-dashed border-border bg-transparent opacity-70 hover:opacity-100 hover:border-border-strong"
          : "border-border bg-bg hover:border-border-strong hover:bg-bg-surface/40",
      )}
    >
      <div className="flex items-center gap-2">
        <span className="text-fg-subtle shrink-0">{block.icon}</span>
        <span className="text-[13px] font-medium text-fg flex-1 min-w-0">
          {block.label}
        </span>
        <StatusDot status={block.status} />
      </div>
      <div className="mt-1 text-[11px] leading-snug text-fg-muted truncate">
        {empty ? block.emptyCta : block.summary}
      </div>
    </div>
  );
}

function namesSummary(names: string[], total: number): string {
  if (total === 0) return "";
  const shown = names.slice(0, 2).join(", ");
  const rest = total - Math.min(names.length, 2);
  return rest > 0 ? `${shown} +${rest} more` : shown;
}

function providerLabel(env: EnvEntry | undefined): string {
  if (!env) return "";
  const id =
    (env.config?.sandbox_provider as string | undefined) ??
    (env.config?.type as string | undefined) ??
    "cloud";
  const desc = friendlyHostingDescription({ id, label: id });
  return desc?.split(" — ")[0] ?? id;
}

export function StackedAssembly() {
  const nav = useNavigate();

  const agentsQ = useApiQuery<Page<AgentRecord>>("/v1/agents", { limit: "1" });
  const modelCardsQ = useApiQuery<Page<ModelCard>>("/v1/model_cards", { limit: "3" });
  const mcpQ = useApiQuery<Page<McpServerEntry>>("/v1/mcp_servers", { limit: "3" });
  const skillsQ = useApiQuery<Page<SkillEntry>>("/v1/skills", { limit: "3" });
  const envQ = useApiQuery<Page<EnvEntry>>("/v1/environments", { limit: "3" });
  const vaultsQ = useApiQuery<Page<VaultEntry>>("/v1/vaults", { limit: "3" });

  // Chat/channels: reuse the same live-installation counts the Integrations
  // Hub already computes (issue #92) rather than inventing a new endpoint.
  const chatQ = useQuery({
    queryKey: ["dashboard-integration-counts"],
    queryFn: async () => {
      const integrations = new IntegrationsApi();
      const [linear, github, slack] = await Promise.all([
        integrations.linear.listInstallations().catch(() => []),
        integrations.github.listInstallations().catch(() => []),
        integrations.slack.listInstallations().catch(() => []),
      ]);
      const names = [
        ...linear.map(() => "Linear"),
        ...github.map(() => "GitHub"),
        ...slack.map(() => "Slack"),
      ];
      return { count: names.length, names };
    },
    staleTime: 30_000,
  });

  const agent = agentsQ.data?.data[0];
  const env = envQ.data?.data[0];

  const modelCardCount = modelCardsQ.data?.data.length ?? 0;
  const mcpCount = mcpQ.data?.data.length ?? 0;
  const skillCount = skillsQ.data?.data.length ?? 0;
  const envCount = envQ.data?.data.length ?? 0;
  const vaultCount = vaultsQ.data?.data.length ?? 0;
  const chatCount = chatQ.data?.count ?? 0;

  const envAttention = (envQ.data?.data ?? []).some((e) => e.status === "building" || e.status === "error");

  const blocks: Block[] = [
    {
      key: "model",
      icon: <ModelCardsIcon className="w-4 h-4" />,
      label: "Model",
      to: "/model-cards",
      status: modelCardCount > 0 ? "ready" : "empty",
      summary:
        typeof agent?.model === "string"
          ? agent.model
          : agent?.model?.id ??
            namesSummary(modelCardsQ.data?.data.map((m) => m.model_id) ?? [], modelCardCount),
      emptyCta: "+ Add a model card — the AI brain",
    },
    {
      key: "mcp",
      icon: <PlugIcon className="w-4 h-4" />,
      label: "MCP / Connections",
      to: "/agents",
      status: mcpCount > 0 ? "ready" : "empty",
      summary: namesSummary(mcpQ.data?.data.map((m) => m.name) ?? [], mcpCount),
      emptyCta: "+ Connect a tool or API",
    },
    {
      key: "skills",
      icon: <SkillsIcon className="w-4 h-4" />,
      label: "Skills",
      to: "/skills",
      status: skillCount > 0 ? "ready" : "empty",
      summary: namesSummary(skillsQ.data?.data.map((s) => s.name) ?? [], skillCount),
      emptyCta: "+ Add a skill (prompts & know-how)",
    },
    {
      key: "runtime",
      icon: <EnvIcon className="w-4 h-4" />,
      label: "Runs on",
      to: "/environments",
      status: envCount === 0 ? "empty" : envAttention ? "attention" : "ready",
      summary: env ? `${env.name} · ${providerLabel(env)}` : "",
      emptyCta: "+ Create a sandbox environment",
    },
    {
      key: "vaults",
      icon: <VaultIcon className="w-4 h-4" />,
      label: "Keys / Secrets",
      to: "/vaults",
      status: vaultCount > 0 ? "ready" : "empty",
      summary: namesSummary(vaultsQ.data?.data.map((v) => v.name) ?? [], vaultCount),
      emptyCta: "+ Store an API key or credential",
    },
    {
      key: "chat",
      icon: <MessageCircleIcon className="w-4 h-4" />,
      label: "Chat / Channels",
      to: "/integrations",
      status: chatQ.isLoading ? "empty" : chatCount > 0 ? "ready" : "empty",
      summary: namesSummary(chatQ.data?.names ?? [], chatCount),
      emptyCta: "+ Connect Telegram, Slack, or a web widget",
    },
  ];

  const agentReady = (agentsQ.data?.data.length ?? 0) > 0;

  return (
    <section className="border border-border rounded-lg p-5 md:p-6">
      <h2 className="font-display text-lg font-semibold text-fg">
        How it fits together
      </h2>
      <p className="mt-1 mb-5 text-[13px] text-fg-muted">
        An agent uses the pieces below. Set each one up — the grey dots mark
        what's still missing.
      </p>

      {/* Hero: the agent */}
      <div
        role="link"
        tabIndex={0}
        onClick={() => nav("/agents")}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            nav("/agents");
          }
        }}
        className={cn(
          "group relative w-full text-left rounded-md border px-4 py-3.5 cursor-pointer select-none",
          "active:translate-y-px transition-[color,background-color,border-color,transform] duration-[var(--dur-quick)] ease-[var(--ease-soft)]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50",
          agentReady
            ? "border-brand/50 bg-brand/5 hover:border-brand"
            : "border-dashed border-border bg-transparent opacity-80 hover:opacity-100 hover:border-border-strong",
        )}
      >
        <div className="flex items-center gap-2">
          <AgentIcon className="w-5 h-5 text-brand shrink-0" />
          <span className="text-[15px] font-semibold text-fg flex-1 min-w-0 truncate">
            {agent?.name ?? "Your agent"}
          </span>
          <StatusDot status={agentReady ? "ready" : "empty"} />
        </div>
        <div className="mt-0.5 text-[12px] text-fg-muted">
          {agentReady ? "Uses the pieces below" : "+ Create your first agent"}
        </div>
      </div>

      {/* Soft "uses" connector */}
      <div className="flex items-center justify-center gap-2 py-2 text-[11px] text-fg-subtle">
        <span className="h-px flex-1 bg-border" />
        <span>uses</span>
        <span className="h-px flex-1 bg-border" />
      </div>

      {/* Building blocks grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        {blocks.map((b) => (
          <BlockCard key={b.key} block={b} nav={nav} />
        ))}
      </div>

      {/* Quiet infra footer — the one real dependency (Agent → Environment
          → runtime provider), stated plainly instead of as an arrow. */}
      {env && (
        <div className="mt-4 flex items-center gap-1.5 text-[12px] text-fg-subtle">
          <StatusDot status={envAttention ? "attention" : "ready"} />
          <span>
            runs on <span className="text-fg-muted">{providerLabel(env)}</span>
          </span>
        </div>
      )}
    </section>
  );
}
