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
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { FitDiagram, type FitCardStatus, type FitStep } from "@duyet/oma-fit-diagram";
import { useApiQuery } from "../lib/useApiQuery";
import { IntegrationsApi } from "../integrations/api/client";
import { friendlyHostingDescription } from "../lib/hostingTypes";
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
import { MessageCircleIcon, GlobeIcon } from "lucide-react";

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

/** Single source of the provider-id fallback chain — keeps labels and
 *  provider marks derived from the same resolution. */
function providerId(env: EnvEntry): string {
  return (
    (env.config?.sandbox_provider as string | undefined) ??
    (env.config?.type as string | undefined) ??
    "cloud"
  );
}

function providerLabel(env: EnvEntry): string {
  const id = providerId(env);
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
  const envStatus: FitCardStatus =
    envs.length === 0 ? "empty" : envAttention ? "attention" : "ready";
  const providers = [...new Set(envs.map(providerLabel))];
  const providerIds = [...new Set(envs.map(providerId))];

  const countStatus = (n: number): FitCardStatus => (n > 0 ? "ready" : "empty");

  const agentReady = agents.length > 0;

  const configure: FitStep = {
    number: "1",
    name: "Configure",
    done: modelCards.length > 0,
    cards: [
      {
        key: "api-key",
        icon: <ApiKeysIcon className="w-4 h-4" />,
        title: "API key",
        status: countStatus(apiKeys.length),
        badges: apiKeys.map((k) => k.name),
        emptyCta: "+ Auth for the CLI & your agent",
        onActivate: () => nav("/api-keys"),
      },
      {
        key: "model",
        icon: <ModelCardsIcon className="w-4 h-4" />,
        title: "Model card",
        status: countStatus(modelCards.length),
        badges: modelCards.map((m) => m.model_id),
        emptyCta: "+ Add a model card — the AI brain",
        onActivate: () => nav("/model-cards"),
      },
    ],
  };

  const compose: FitStep = {
    number: "2",
    name: "Compose",
    done: agentReady,
    wide: true,
    cards: [
      {
        key: "agent",
        hero: true,
        icon: <AgentIcon className="w-5 h-5" />,
        title: "Agent",
        status: agentReady ? "ready" : "empty",
        badges: agents.map((a) => a.name),
        emptyCta: "+ Create your first agent — it composes everything in step 1",
        onActivate: () => nav(agentReady ? "/agents" : "/agents/new"),
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
        status: countStatus(skills.length),
        badges: skills.map((s) => s.name),
        emptyCta: "+ Prompts & know-how",
        onActivate: () => nav("/skills"),
      },
      // Optional knowledge + data the agent works with — grouped with the
      // agent it augments; sessions mount them at runtime.
      [
        {
          key: "memory",
          icon: <MemoryIcon className="w-4 h-4" />,
          title: "Memory",
          status: countStatus(memoryStores.length),
          badges: memoryStores.map((m) => m.name),
          emptyCta: "+ Notes it keeps",
          onActivate: () => nav("/memory"),
        },
        {
          key: "files",
          icon: <FilesIcon className="w-4 h-4" />,
          title: "Files",
          status: countStatus(files.length),
          badges: files.map((f) => f.filename),
          emptyCta: "+ Data to mount",
          onActivate: () => nav("/files"),
        },
      ],
    ],
  };

  const run: FitStep = {
    number: "3",
    name: "Run",
    done: sessions.length > 0,
    chain: true,
    // Completes the formula in place: env + vaults (+ the agent arriving
    // from step 2) compose into a session, which runs inside the sandbox.
    chainLabels: ["+ agent =", "runs inside"],
    cards: [
      // `session = agent + env + vaults` — the agent arrives from step 2's
      // pointer; env + vaults are the session-scoped pieces, so they sit
      // here as the chain's inputs, mirroring Skills-under-Agent in COMPOSE.
      [
        {
          key: "env",
          icon: <EnvIcon className="w-4 h-4" />,
          title: "Environment",
          status: envStatus,
          badges: envs.map((e) => e.name),
          emptyCta: "+ Create a sandbox environment",
          onActivate: () => nav("/environments"),
        },
        {
          key: "vaults",
          icon: <VaultIcon className="w-4 h-4" />,
          title: "Keys (Vault)",
          status: countStatus(vaults.length),
          badges: vaults.map((v) => v.name),
          emptyCta: "+ Secrets it calls out with",
          onActivate: () => nav("/vaults"),
        },
      ],
      {
        key: "session",
        icon: <SessionsIcon className="w-4 h-4" />,
        title: "Session",
        status: countStatus(sessions.length),
        badges: [],
        emptyCta: "",
        description: "One conversation or task — streamed, resumable event log.",
        onActivate: () => nav("/sessions"),
      },
      {
        key: "runtime",
        icon: <RuntimesIcon className="w-4 h-4" />,
        title: "Sandbox",
        status: envStatus,
        badges: providers,
        emptyCta: "+ Where sandboxes run — set by your environment",
        description:
          providers.length > 0 ? "Where tools execute — set by your environment." : undefined,
        providerMarks: providerIds,
        onActivate: () => nav("/runtimes"),
      },
    ],
  };

  const reach: FitStep = {
    number: "4",
    name: "Reach",
    optional: true,
    done: channels.length > 0 || pubs.length > 0,
    cards: [
      {
        key: "channels",
        icon: <MessageCircleIcon className="w-4 h-4" />,
        title: "Channels",
        status: countStatus(channels.length),
        badges: channels,
        emptyCta: "+ Connect Telegram, Slack, or GitHub",
        onActivate: () => nav("/integrations"),
      },
      {
        key: "publications",
        icon: <GlobeIcon className="w-4 h-4" />,
        title: "Publications",
        status: countStatus(pubs.length),
        badges: pubs.map((p) => p.title),
        emptyCta: "+ Publish a public chat page or widget",
        onActivate: () => nav("/my-bots"),
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

      <FitDiagram
        steps={steps}
        collapsible
        formula={[
          { lhs: "agent", parts: ["model", "skills", "mcp"] },
          { lhs: "session", parts: ["agent", "env", "vaults"] },
        ]}
      />
    </section>
  );
}
