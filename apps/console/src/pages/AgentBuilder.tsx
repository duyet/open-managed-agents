import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useApi } from "../lib/api";

interface Skill {
  id: string;
  name: string;
  description: string;
}

type IntegrationType = "linear" | "github" | "slack";

const SYSTEM_PROMPT_PRESETS = [
  {
    label: "Friendly assistant",
    prompt: "You are a helpful, friendly assistant. Be concise and clear in your responses.",
  },
  {
    label: "Code reviewer",
    prompt: "You are an expert code reviewer. Analyze code for bugs, security issues, performance problems, and style violations. Provide actionable feedback.",
  },
  {
    label: "Data analyst",
    prompt: "You are a data analyst. Help users understand their data through analysis, visualization, and clear explanations. Use Python for data work.",
  },
  {
    label: "DevOps engineer",
    prompt: "You are a DevOps engineer. Help with infrastructure, deployment, CI/CD, and monitoring. Prefer bash and infrastructure-as-code approaches.",
  },
  {
    label: "Technical writer",
    prompt: "You are a technical writer. Help write clear, well-structured documentation. Focus on accuracy, readability, and completeness.",
  },
  {
    label: "Custom",
    prompt: "",
  },
];

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

const INTEGRATIONS: Array<{ id: IntegrationType; label: string; description: string }> = [
  { id: "linear", label: "Linear", description: "Issue tracking" },
  { id: "github", label: "GitHub", description: "Code repositories" },
  { id: "slack", label: "Slack", description: "Team messaging" },
];

interface FormState {
  name: string;
  description: string;
  model: string;
  system: string;
  tools: string[];
  selectedPreset: string;
  skillIds: string[];
  integrations: IntegrationType[];
}

const INITIAL: FormState = {
  name: "",
  description: "",
  model: "claude-sonnet-4-6",
  system: "",
  tools: ["bash", "read", "write", "edit", "glob", "grep", "web_fetch"],
  selectedPreset: "Friendly assistant",
  skillIds: [],
  integrations: [],
};

export function AgentBuilder() {
  const { api } = useApi();
  const nav = useNavigate();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<FormState>(INITIAL);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [skillSearch, setSkillSearch] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api<{ data: Skill[] }>("/v1/skills?limit=200")
      .then((r) => setSkills(r.data))
      .catch(() => {});
  }, [api]);

  const filteredSkills = useMemo(
    () => skills.filter((s) => s.name.toLowerCase().includes(skillSearch.toLowerCase())),
    [skills, skillSearch],
  );

  const update = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

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
              <option value="gpt-4o">GPT-4o</option>
              <option value="gpt-4o-mini">GPT-4o Mini</option>
            </select>
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
            <div className="grid grid-cols-2 gap-2">
              {SYSTEM_PROMPT_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  onClick={() => update({ selectedPreset: preset.label, system: preset.prompt })}
                  className={`text-left px-3 py-2 rounded-md border text-sm transition-colors ${
                    form.selectedPreset === preset.label
                      ? "border-brand bg-brand/5 text-brand"
                      : "border-border text-fg-muted hover:border-border-strong"
                  }`}
                >
                  {preset.label}
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
          {AVAILABLE_TOOLS.map((tool) => (
            <label key={tool.id} className="flex items-start gap-3 p-3 rounded-md border border-border hover:border-border-strong cursor-pointer transition-colors">
              <input
                type="checkbox"
                checked={form.tools.includes(tool.id)}
                onChange={() => {
                  update({
                    tools: form.tools.includes(tool.id)
                      ? form.tools.filter((t) => t !== tool.id)
                      : [...form.tools, tool.id],
                  });
                }}
                className="mt-0.5 accent-brand"
              />
              <div>
                <div className="text-sm font-medium text-fg">{tool.label}</div>
                <div className="text-xs text-fg-muted">{tool.description}</div>
              </div>
            </label>
          ))}
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
              {filteredSkills.map((skill) => (
                <label key={skill.id} className="flex items-start gap-3 p-3 rounded-md border border-border hover:border-border-strong cursor-pointer transition-colors">
                  <input
                    type="checkbox"
                    checked={form.skillIds.includes(skill.id)}
                    onChange={() => {
                      update({
                        skillIds: form.skillIds.includes(skill.id)
                          ? form.skillIds.filter((s) => s !== skill.id)
                          : [...form.skillIds, skill.id],
                      });
                    }}
                    className="mt-0.5 accent-brand"
                  />
                  <div>
                    <div className="text-sm font-medium text-fg">{skill.name}</div>
                    <div className="text-xs text-fg-muted">{skill.description}</div>
                  </div>
                </label>
              ))}
            </div>
          )}
        </div>
      ),
    },
    {
      title: "Integrations",
      description: "Connect external services.",
      content: (
        <div className="space-y-2">
          {INTEGRATIONS.map((int) => (
            <label key={int.id} className="flex items-start gap-3 p-3 rounded-md border border-border hover:border-border-strong cursor-pointer transition-colors">
              <input
                type="checkbox"
                checked={form.integrations.includes(int.id)}
                onChange={() => {
                  update({
                    integrations: form.integrations.includes(int.id)
                      ? form.integrations.filter((i) => i !== int.id)
                      : [...form.integrations, int.id],
                  });
                }}
                className="mt-0.5 accent-brand"
              />
              <div>
                <div className="text-sm font-medium text-fg">{int.label}</div>
                <div className="text-xs text-fg-muted">{int.description}</div>
              </div>
            </label>
          ))}
          <p className="text-xs text-fg-subtle mt-2">
            Integrations are configured after creation. This just toggles which MCP servers are available.
          </p>
        </div>
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
          <SummaryRow label="Tools" value={form.tools.length > 0 ? form.tools.join(", ") : "None"} />
          <SummaryRow label="Skills" value={form.skillIds.length > 0 ? `${form.skillIds.length} selected` : "None"} />
          <SummaryRow label="Integrations" value={form.integrations.length > 0 ? form.integrations.join(", ") : "None"} />
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
      const body: Record<string, unknown> = {
        name: form.name,
        description: form.description,
        model: form.model,
        system: form.system,
        tools: [
          {
            type: "agent_toolset_20260401",
            default_config: { enabled: true },
            configs: AVAILABLE_TOOLS.map((t) => ({
              name: t.id,
              enabled: form.tools.includes(t.id),
            })),
          },
        ],
      };
      if (form.skillIds.length > 0) {
        body.skills = form.skillIds.map((id) => ({ skill_id: id, type: "custom" }));
      }
      if (form.integrations.length > 0) {
        body.mcp_servers = form.integrations.map((name) => ({
          name,
          type: "url",
          url: `https://mcp.${name === "github" ? "api.githubcopilot.com/mcp" : `${name}.app/mcp`}`,
        }));
      }

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
