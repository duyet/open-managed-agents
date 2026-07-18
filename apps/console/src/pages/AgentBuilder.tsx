import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useApi } from "../lib/api";
import { AgentCreateForm, type FormRuntime } from "./agents/AgentFormDialog";
import type { ModelCard } from "@duyet/oma-api-types";
import type { AgentRecord as Agent } from "../types/agent";

/**
 * Full-page New Agent route (`/agents/new`). Renders the exact same
 * `AgentCreateForm` the New Agent dialog uses (template picker → tabbed form,
 * runtime-first cloud/local flow) — one implementation, two hosts. The page
 * only fetches the pickers' aux data and provides the surrounding chrome.
 */
export function AgentBuilder() {
  const { api } = useApi();
  const nav = useNavigate();

  const [allAgents, setAllAgents] = useState<Agent[]>([]);
  const [customSkills, setCustomSkills] = useState<
    Array<{ id: string; name: string; description: string }>
  >([]);
  const [modelCards, setModelCards] = useState<ModelCard[]>([]);
  const [runtimes, setRuntimes] = useState<FormRuntime[]>([]);

  // Aux fetches for the form's pickers. Each is best-effort — a missing list
  // degrades a dropdown but shouldn't block agent creation.
  useEffect(() => {
    (async () => {
      const all = await api<{ data: Agent[] }>("/v1/agents?limit=200&status=any");
      setAllAgents(all.data);
    })().catch((e) => console.warn("[AgentBuilder] /v1/agents aux fetch failed", e));
    (async () => {
      const sk = await api<{
        data: Array<{ id: string; name: string; description: string }>;
      }>("/v1/skills");
      setCustomSkills(sk.data);
    })().catch((e) => console.warn("[AgentBuilder] /v1/skills aux fetch failed", e));
    (async () => {
      const mc = await api<{ data: ModelCard[] }>("/v1/model_cards?limit=200");
      setModelCards(mc.data);
    })().catch((e) => console.warn("[AgentBuilder] /v1/model_cards aux fetch failed", e));
    (async () => {
      const rt = await api<{ runtimes: FormRuntime[] }>("/v1/runtimes");
      setRuntimes(rt.runtimes);
    })().catch((e) => console.warn("[AgentBuilder] /v1/runtimes aux fetch failed", e));
  }, [api]);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="w-full px-4 py-8">
        <AgentCreateForm
          variant="page"
          onCancel={() => nav("/agents")}
          allAgents={allAgents}
          customSkills={customSkills}
          modelCards={modelCards}
          runtimes={runtimes}
        />
      </div>
    </div>
  );
}
