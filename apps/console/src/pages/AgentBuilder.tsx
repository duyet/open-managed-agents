import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useApi } from "../lib/api";
import { McpServerPickerModal } from "../components/McpServerPickerModal";
import { RuntimeInfo } from "../components/RuntimeInfo";
import type { McpRegistryEntry } from "../data/mcp-registry";
import { formToConfig, INITIAL_FORM, McpTab, type FormState } from "./agents/AgentFormDialog";
import type { ModelCard } from "@duyet/oma-api-types";

interface Skill {
  id: string;
  name: string;
  description: string;
}

/** MCP server entry shape, derived from the shared `FormState` rather than
 *  re-declared here — keeps this file from drifting out of sync with the
 *  real (unexported) `McpEntry` in AgentFormDialog.tsx. */
type McpEntry = FormState["mcpServers"][number];

/**
 * Wizard form state = the exact same `FormState` the standard create flow
 * (`AgentFormDialog`/`AgentEditDialog`) uses, plus one wizard-only UI field
 * (`selectedPreset`, which preset button is highlighted). Submitting always
 * goes through the shared `formToConfig` builder, so this wizard produces
 * byte-identical `/v1/agents` payloads to the standard create path instead
 * of hand-rolling its own — see issue #183.
 */
type BuilderFormState = FormState & {
  selectedPreset: string;
};

/** Preset metadata drives the tag / integration filter rows above the
 *  template grid. `tags` are broad categories; `integrations` name the
 *  external services the preset is written to work against. "Custom" has
 *  neither and is always shown so a filtered view never dead-ends. */
const SYSTEM_PROMPT_PRESETS: {
  label: string;
  prompt: string;
  tags: string[];
  integrations: string[];
}[] = [
  {
    label: "Friendly assistant",
    prompt: "You are a helpful, friendly assistant. Be concise and clear in your responses.",
    tags: ["general"],
    integrations: [],
  },
  {
    label: "Code reviewer",
    prompt: "You are an expert code reviewer. Analyze code for bugs, security issues, performance problems, and style violations. Provide actionable feedback.",
    tags: ["engineering"],
    integrations: ["github"],
  },
  {
    label: "Bug triage",
    prompt: "You are a bug-triage engineer. When mentioned on an issue, reproduce the bug in your sandbox, check out a branch, commit a fix, open a pull request, and post your findings back as an issue comment.",
    tags: ["engineering", "automation"],
    integrations: ["github"],
  },
  {
    label: "Support agent",
    prompt: "You are a support agent. Answer customer questions from the team's documentation, reply in the thread where the question was asked, and escalate to a human when unsure.",
    tags: ["support"],
    integrations: ["slack"],
  },
  {
    label: "Incident responder",
    prompt: "You are an incident responder. When an alert fires, triage it: identify the failing service, file a tracking ticket with your findings, and open a war room with a summary of impact and next steps.",
    tags: ["operations", "automation"],
    integrations: ["sentry", "linear", "slack"],
  },
  {
    label: "Data analyst",
    prompt: "You are a data analyst. Help users understand their data through analysis, visualization, and clear explanations. Use Python for data work.",
    tags: ["data"],
    integrations: [],
  },
  {
    label: "DevOps engineer",
    prompt: "You are a DevOps engineer. Help with infrastructure, deployment, CI/CD, and monitoring. Prefer bash and infrastructure-as-code approaches.",
    tags: ["engineering", "operations"],
    integrations: ["github"],
  },
  {
    label: "Technical writer",
    prompt: "You are a technical writer. Help write clear, well-structured documentation. Focus on accuracy, readability, and completeness.",
    tags: ["writing"],
    integrations: [],
  },
  {
    label: "Custom",
    prompt: "",
    tags: [],
    integrations: [],
  },
];

const PRESET_TAGS = [...new Set(SYSTEM_PROMPT_PRESETS.flatMap((p) => p.tags))];
const PRESET_INTEGRATIONS = [...new Set(SYSTEM_PROMPT_PRESETS.flatMap((p) => p.integrations))];

const AVAILABLE_TOOLS = [
  { id: "bash", label: "Bash", description: "Execute shell commands" },
  { id: "read", label: "Read", description: "Read files" },
  { id: "write", label: "Write", description: "Write files" },
  { id: "edit", label: "Edit", description: "Edit files" },
  { id: "glob", label: "Glob", description: "Find files by pattern" },
  { id: "grep", label: "Grep", description: "Search file contents" },
  { id: "web_fetch", label: "Web Fetch", description: "Fetch URLs" },
  { id: "web_search", label: "Web Search", description: "Search the web" },
];

const INITIAL: BuilderFormState = {
  ...INITIAL_FORM,
  model: "claude-sonnet-4-6",
  selectedPreset: "Friendly assistant",
  // web_search off by default; every other built-in tool stays enabled via
  // toolDefaultEnabled (inherited from INITIAL_FORM).
  toolOverrides: { web_search: "disabled" },
};

export function AgentBuilder() {
  const { api } = useApi();
  const nav = useNavigate();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<BuilderFormState>(INITIAL);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [skillSearch, setSkillSearch] = useState("");
  const [modelCards, setModelCards] = useState<ModelCard[]>([]);
  const [showMcpPicker, setShowMcpPicker] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [presetTag, setPresetTag] = useState<string | null>(null);
  const [presetIntegration, setPresetIntegration] = useState<string | null>(null);

  useEffect(() => {
    api<{ data: Skill[] }>("/v1/skills?limit=200")
      .then((r) => setSkills(r.data))
      .catch(() => {});
  }, [api]);

  // Real model cards — same source AgentFormDialog's model picker uses.
  // Any model beyond the two built-in Anthropic defaults is only offered
  // here if a real card backs it (issue #183: no more hardcoded gpt-4o).
  useEffect(() => {
    api<{ data: ModelCard[] }>("/v1/model_cards?limit=200")
      .then((r) => setModelCards(r.data))
      .catch(() => {});
  }, [api]);

  const filteredSkills = useMemo(
    () => skills.filter((s) => s.name.toLowerCase().includes(skillSearch.toLowerCase())),
    [skills, skillSearch],
  );

  const update = (patch: Partial<BuilderFormState>) => setForm((f) => ({ ...f, ...patch }));

  const enabledTools = AVAILABLE_TOOLS.filter(
    (t) => (form.toolOverrides[t.id] ?? "default") !== "disabled",
  ).map((t) => t.id);

  // MCP server handlers — same logic as AgentFormDialog/AgentEditDialog's,
  // driving the same McpTab + McpServerPickerModal below, so "Integrations"
  // adds a real curated URL (MCP_REGISTRY) or an explicit user-pasted one —
  // never a fabricated `https://mcp.<name>.app/mcp` guess (issue #183).
  const addMcp = () =>
    update({ mcpServers: [...form.mcpServers, { name: "", type: "url", url: "" }] });
  const addMcpFromRegistry = (entry: McpRegistryEntry) => {
    if (form.mcpServers.some((m) => m.url === entry.url)) return;
    update({
      mcpServers: [...form.mcpServers, { name: entry.id, type: "url", url: entry.url }],
    });
  };
  const updateMcp = (i: number, field: keyof McpEntry, val: string) => {
    const updated = [...form.mcpServers];
    updated[i] = { ...updated[i], [field]: val };
    update({ mcpServers: updated });
  };
  const removeMcp = (i: number) =>
    update({ mcpServers: form.mcpServers.filter((_, j) => j !== i) });

  const mcpInputCls =
    "w-full border border-border rounded-md px-3 py-2 min-h-11 sm:min-h-0 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] placeholder:text-fg-subtle";

  const steps = [
    {
      title: "Name & Description",
      description: "Give your agent a name and describe its purpose.",
      content: (
        <div className="space-y-4">
          <div>
            <label className="text-sm text-fg-muted block mb-1">Agent name *</label>
            <input
              value={form.name}
              onChange={(e) => update({ name: e.target.value })}
              className="w-full border border-border rounded-md px-3 py-2 text-sm bg-bg text-fg outline-none focus:border-brand"
              placeholder="My agent"
            />
          </div>
          <div>
            <label className="text-sm text-fg-muted block mb-1">Description</label>
            <textarea
              value={form.description}
              onChange={(e) => update({ description: e.target.value })}
              className="w-full border border-border rounded-md px-3 py-2 text-sm bg-bg text-fg outline-none focus:border-brand min-h-[80px]"
              placeholder="What does this agent do?"
            />
          </div>
          <div>
            <label className="text-sm text-fg-muted block mb-1">Model</label>
            <select
              value={form.model}
              onChange={(e) => update({ model: e.target.value })}
              className="w-full border border-border rounded-md px-3 py-2 text-sm bg-bg text-fg outline-none focus:border-brand"
            >
              <option value="claude-sonnet-4-6">Claude Sonnet 4-6</option>
              <option value="claude-haiku-4-5">Claude Haiku 4-5</option>
              {modelCards
                .filter(
                  (mc) =>
                    mc.model_id !== "claude-sonnet-4-6" && mc.model_id !== "claude-haiku-4-5",
                )
                .map((mc) => (
                  <option key={mc.id} value={mc.model_id}>
                    {mc.is_default ? "★ " : ""}
                    {mc.model_id}
                    {mc.model !== mc.model_id ? ` (${mc.model})` : ""}
                  </option>
                ))}
            </select>
            {modelCards.length === 0 && (
              <p className="text-xs text-fg-subtle mt-1">
                Only the built-in Anthropic defaults are available until a{" "}
                <a
                  href="/model-cards"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-fg-muted"
                >
                  model card
                </a>{" "}
                is configured (opens in a new tab — your draft here is kept).
              </p>
            )}
          </div>
        </div>
      ),
    },
    {
      title: "System Prompt",
      description: "Define how your agent behaves.",
      content: (
        <div className="space-y-4">
          <div>
            <label className="text-sm text-fg-muted block mb-1">Template</label>
            {/* Tag + integration filter rows. Single-select toggles; "Custom"
                is exempt from filtering so the grid never goes empty. */}
            <div className="flex flex-wrap items-center gap-1.5 mb-2">
              {PRESET_TAGS.map((tag) => (
                <button
                  key={tag}
                  onClick={() => setPresetTag(presetTag === tag ? null : tag)}
                  className={`px-2 py-0.5 rounded-full border text-xs transition-colors ${
                    presetTag === tag
                      ? "border-brand bg-brand/10 text-brand"
                      : "border-border text-fg-muted hover:border-border-strong"
                  }`}
                >
                  {tag}
                </button>
              ))}
              <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
              {PRESET_INTEGRATIONS.map((integration) => (
                <button
                  key={integration}
                  onClick={() =>
                    setPresetIntegration(presetIntegration === integration ? null : integration)
                  }
                  className={`px-2 py-0.5 rounded-full border text-xs font-mono transition-colors ${
                    presetIntegration === integration
                      ? "border-brand bg-brand/10 text-brand"
                      : "border-border text-fg-muted hover:border-border-strong"
                  }`}
                >
                  {integration}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {SYSTEM_PROMPT_PRESETS.filter(
                (preset) =>
                  preset.label === "Custom" ||
                  ((!presetTag || preset.tags.includes(presetTag)) &&
                    (!presetIntegration || preset.integrations.includes(presetIntegration))),
              ).map((preset) => (
                <button
                  key={preset.label}
                  onClick={() => update({ selectedPreset: preset.label, system: preset.prompt })}
                  className={`text-left px-3 py-2 rounded-md border text-sm transition-colors ${
                    form.selectedPreset === preset.label
                      ? "border-brand bg-brand/5 text-brand"
                      : "border-border text-fg-muted hover:border-border-strong"
                  }`}
                >
                  <span className="block">{preset.label}</span>
                  {(preset.tags.length > 0 || preset.integrations.length > 0) && (
                    <span className="block mt-0.5 text-xs text-fg-subtle">
                      {[...preset.tags, ...preset.integrations].join(" · ")}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-sm text-fg-muted block mb-1">System Prompt *</label>
            <textarea
              value={form.system}
              onChange={(e) => update({ system: e.target.value })}
              className="w-full border border-border rounded-md px-3 py-2 text-sm bg-bg text-fg outline-none focus:border-brand min-h-[200px] font-mono"
              placeholder="You are a..."
            />
          </div>
        </div>
      ),
    },
    {
      title: "Tools",
      description: "Select which tools the agent can use.",
      content: (
        <div className="space-y-2">
          {AVAILABLE_TOOLS.map((tool) => {
            const enabled = (form.toolOverrides[tool.id] ?? "default") !== "disabled";
            return (
              <label key={tool.id} className="flex items-start gap-3 p-3 rounded-md border border-border hover:border-border-strong cursor-pointer transition-colors">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={() => {
                    const next = { ...form.toolOverrides };
                    if (enabled) next[tool.id] = "disabled";
                    else delete next[tool.id];
                    update({ toolOverrides: next });
                  }}
                  className="mt-0.5 accent-brand"
                />
                <div>
                  <div className="text-sm font-medium text-fg">{tool.label}</div>
                  <div className="text-xs text-fg-muted">{tool.description}</div>
                </div>
              </label>
            );
          })}
        </div>
      ),
    },
    {
      title: "Skills",
      description: "Attach reusable prompt fragments.",
      content: (
        <div className="space-y-4">
          <input
            value={skillSearch}
            onChange={(e) => setSkillSearch(e.target.value)}
            className="w-full border border-border rounded-md px-3 py-2 text-sm bg-bg text-fg outline-none focus:border-brand"
            placeholder="Search skills…"
          />
          {filteredSkills.length === 0 ? (
            <p className="text-sm text-fg-subtle">No skills found. Create one from the Skills page.</p>
          ) : (
            <div className="space-y-2 max-h-[400px] overflow-y-auto">
              {filteredSkills.map((skill) => {
                const active = form.skills.some((s) => s.skill_id === skill.id);
                return (
                  <label key={skill.id} className="flex items-start gap-3 p-3 rounded-md border border-border hover:border-border-strong cursor-pointer transition-colors">
                    <input
                      type="checkbox"
                      checked={active}
                      onChange={() => {
                        update({
                          skills: active
                            ? form.skills.filter((s) => s.skill_id !== skill.id)
                            : [
                                ...form.skills,
                                { type: "custom", skill_id: skill.id, version: "latest" },
                              ],
                        });
                      }}
                      className="mt-0.5 accent-brand"
                    />
                    <div>
                      <div className="text-sm font-medium text-fg">{skill.name}</div>
                      <div className="text-xs text-fg-muted">{skill.description}</div>
                    </div>
                  </label>
                );
              })}
            </div>
          )}
        </div>
      ),
    },
    {
      title: "Integrations",
      description: "Connect external services.",
      // Reuses the exact same McpTab (+ McpServerPickerModal below) as the
      // standard create/edit flow: pick a real, curated MCP server or paste
      // a custom URL. No fabricated hosts (issue #183).
      content: (
        <McpTab
          form={form}
          inputCls={mcpInputCls}
          onPickFromRegistry={() => setShowMcpPicker(true)}
          addMcp={addMcp}
          updateMcp={updateMcp}
          removeMcp={removeMcp}
        />
      ),
    },
    {
      title: "Summary & Create",
      description: "Review and create your agent.",
      content: (
        <div className="space-y-3">
          <SummaryRow label="Name" value={form.name} />
          <SummaryRow label="Description" value={form.description || "—"} />
          <SummaryRow label="Model" value={form.model} />
          <div>
            <span className="text-xs text-fg-muted block mb-1">System Prompt</span>
            <pre className="text-xs text-fg bg-bg-surface rounded-md p-3 max-h-[120px] overflow-y-auto whitespace-pre-wrap">
              {form.system || "—"}
            </pre>
          </div>
          <SummaryRow
            label="Tools"
            value={enabledTools.length > 0 ? enabledTools.join(", ") : "None"}
          />
          <SummaryRow
            label="Skills"
            value={form.skills.length > 0 ? `${form.skills.length} selected` : "None"}
          />
          <SummaryRow
            label="Integrations"
            value={
              form.mcpServers.length > 0
                ? form.mcpServers.map((m) => m.name || m.url).join(", ")
                : "None"
            }
          />
          <div className="pt-2 border-t border-border">
            <span className="text-xs text-fg-muted block mb-2">Runtime</span>
            <RuntimeInfo harness={form.harness} />
          </div>
        </div>
      ),
    },
  ];

  const canAdvance = (): boolean => {
    switch (step) {
      case 0: return form.name.trim().length > 0;
      case 1: return form.system.trim().length > 0;
      default: return true;
    }
  };

  const createAgent = async () => {
    setSubmitting(true);
    try {
      // Same payload builder the standard create flow uses — guarantees
      // this wizard's /v1/agents body matches AgentFormDialog's exactly
      // (issue #183: un-fork the create flow).
      const body = formToConfig(form);
      const agent = await api<{ id: string }>("/v1/agents", {
        method: "POST",
        body: JSON.stringify(body),
      });
      nav(`/agents/${agent.id}`);
    } catch {
      // error handled by api()
    }
    setSubmitting(false);
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-2xl mx-auto px-4 py-8">
        <header className="mb-8">
          <h1 className="font-display text-2xl font-semibold text-fg">Create Agent</h1>
          <p className="text-sm text-fg-muted mt-1">
            Step {step + 1} of {steps.length}: {steps[step].title}
          </p>
          {/* Step indicator */}
          <div className="flex gap-1.5 mt-4">
            {steps.map((_, i) => (
              <div
                key={i}
                className={`h-1 flex-1 rounded-full transition-colors ${
                  i <= step ? "bg-brand" : "bg-border"
                }`}
              />
            ))}
          </div>
        </header>

        <section className="border border-border rounded-lg p-6">
          <h2 className="font-display text-lg font-semibold text-fg mb-1">{steps[step].title}</h2>
          <p className="text-sm text-fg-muted mb-6">{steps[step].description}</p>
          {steps[step].content}
        </section>

        <div className="flex justify-between mt-6">
          <button
            onClick={() => setStep(Math.max(0, step - 1))}
            disabled={step === 0}
            className="px-4 py-2 text-sm font-medium text-fg-muted hover:text-fg disabled:opacity-30 transition-colors"
          >
            ← Back
          </button>
          {step < steps.length - 1 ? (
            <button
              onClick={() => setStep(Math.min(steps.length - 1, step + 1))}
              disabled={!canAdvance()}
              className="px-5 py-2 bg-brand text-brand-fg text-sm font-medium rounded-md hover:bg-brand-hover disabled:opacity-50 transition-colors"
            >
              Next →
            </button>
          ) : (
            <button
              onClick={createAgent}
              disabled={submitting || !form.name || !form.system}
              className="px-5 py-2 bg-brand text-brand-fg text-sm font-medium rounded-md hover:bg-brand-hover disabled:opacity-50 transition-colors"
            >
              {submitting ? "Creating…" : "Create Agent"}
            </button>
          )}
        </div>
      </div>

      {/* MCP server registry picker — same MCP_REGISTRY the vault page and
          the standard create/edit flow use. */}
      <McpServerPickerModal
        open={showMcpPicker}
        onClose={() => setShowMcpPicker(false)}
        alreadyAddedUrls={form.mcpServers.map((m) => m.url)}
        onPick={addMcpFromRegistry}
      />
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-xs text-fg-muted shrink-0 w-24">{label}</span>
      <span className="text-sm text-fg">{value}</span>
    </div>
  );
}
