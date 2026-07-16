// Reusable editor for persistent environment-level env vars. Used by both the
// EnvironmentDetail page and the create-environment dialog. Supports:
//   - name / value / "secret" (sensitive) rows with mask + reveal
//   - pasting a `.env` block that parses into rows (merge, later keys win)
//   - drag-and-drop of a `.env` file (plus a file-picker fallback)
//
// Sensitive values map to EnvVarSpec.sensitive on the wire — the API stores
// them out-of-band and never echoes them back, so a sensitive row loads blank
// with `hasStoredSecret` set (blank input on save = keep the stored value).

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { parseDotenv } from "../lib/dotenv";

/** Wire shape — mirrors EnvVarSpec in @duyet/oma-api-types. */
export interface EnvVarSpec {
  name: string;
  value?: string;
  sensitive?: boolean;
  has_value?: boolean;
}

/** Editor row. `hasStoredSecret` distinguishes a sensitive var whose value is
 *  already stored (blank input = keep it) from a brand-new one. */
export interface EnvVarRow {
  name: string;
  value: string;
  sensitive: boolean;
  hasStoredSecret: boolean;
}

export function envVarsToRows(vars: EnvVarSpec[] | undefined): EnvVarRow[] {
  if (!vars) return [];
  return vars.map((v) => ({
    name: v.name,
    value: v.sensitive ? "" : (v.value ?? ""),
    sensitive: !!v.sensitive,
    hasStoredSecret: !!v.sensitive && !!v.has_value,
  }));
}

export function rowsToEnvVars(rows: EnvVarRow[]): EnvVarSpec[] {
  const out: EnvVarSpec[] = [];
  for (const row of rows) {
    const name = row.name.trim();
    if (!name) continue;
    if (row.sensitive) {
      if (row.value.length > 0) out.push({ name, sensitive: true, value: row.value });
      else out.push({ name, sensitive: true });
    } else {
      out.push({ name, value: row.value });
    }
  }
  return out;
}

const envInputCls =
  "min-w-0 border border-border rounded-md px-3 py-2 text-[13px] bg-bg text-fg outline-none focus:border-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] placeholder:text-fg-subtle font-mono";

export function EnvVarsEditor({
  rows,
  setRows,
}: {
  rows: EnvVarRow[];
  setRows: React.Dispatch<React.SetStateAction<EnvVarRow[]>>;
}) {
  const [pasteText, setPasteText] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [revealed, setRevealed] = useState<Set<number>>(new Set());

  function toggleReveal(i: number) {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  function mergeDotenv(text: string) {
    const parsed = parseDotenv(text);
    if (parsed.length === 0) {
      toast.error("No KEY=value pairs found");
      return;
    }
    setRows((rs) => {
      const next = [...rs];
      for (const { name, value } of parsed) {
        const idx = next.findIndex((r) => r.name === name);
        if (idx !== -1) next[idx] = { ...next[idx], value };
        else next.push({ name, value, sensitive: false, hasStoredSecret: false });
      }
      return next;
    });
    toast.success(`Parsed ${parsed.length} variable${parsed.length === 1 ? "" : "s"}`);
  }

  function readFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => mergeDotenv(String(reader.result ?? ""));
    reader.readAsText(file);
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const file = e.dataTransfer.files?.[0];
        if (file) readFile(file);
      }}
      className={`space-y-3 rounded-md transition-colors ${
        dragOver ? "outline outline-2 outline-dashed outline-brand/60 bg-brand/5" : ""
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] text-fg-muted">
          {rows.length === 0 ? "No environment variables." : `${rows.length} variable(s)`}
        </span>
        <button
          type="button"
          onClick={() =>
            setRows((rs) => [...rs, { name: "", value: "", sensitive: false, hasStoredSecret: false }])
          }
          className="inline-flex items-center justify-center text-xs px-2.5 py-1.5 border border-border rounded-md hover:bg-bg-surface text-fg-muted hover:text-fg"
        >
          + Add variable
        </button>
      </div>

      {rows.length > 0 && (
        <div className="space-y-2">
          {rows.map((row, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                value={row.name}
                onChange={(e) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))}
                placeholder="ENV_VAR_NAME"
                aria-label="Variable name"
                className={`${envInputCls} w-1/3`}
              />
              <div className="relative flex-1 min-w-0">
                <input
                  value={row.value}
                  type={row.sensitive && !revealed.has(i) ? "password" : "text"}
                  onChange={(e) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
                  placeholder={row.sensitive && row.hasStoredSecret ? "•••••• (stored — leave blank to keep)" : "value"}
                  aria-label="Variable value"
                  className={`${envInputCls} w-full ${row.sensitive ? "pr-12" : ""}`}
                />
                {row.sensitive && (
                  <button
                    type="button"
                    onClick={() => toggleReveal(i)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex items-center justify-center px-1 text-xs text-fg-subtle hover:text-fg"
                    aria-label="Toggle value visibility"
                  >
                    {revealed.has(i) ? "hide" : "show"}
                  </button>
                )}
              </div>
              <label className="flex items-center gap-1 text-[11px] text-fg-muted shrink-0 cursor-pointer" title="Store as a masked secret">
                <input
                  type="checkbox"
                  checked={row.sensitive}
                  onChange={(e) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, sensitive: e.target.checked } : r)))}
                />
                secret
              </label>
              <button
                type="button"
                onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                aria-label="Remove environment variable"
                className="inline-flex items-center justify-center min-w-8 p-1.5 rounded-md text-fg-subtle hover:text-fg hover:bg-bg-surface"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="pt-2 border-t border-border space-y-2">
        <label className="block text-[12px] text-fg-muted" htmlFor="env-dotenv-paste">
          Paste a <span className="font-mono">.env</span> block or drop a file to parse into rows
        </label>
        <textarea
          id="env-dotenv-paste"
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
          rows={3}
          placeholder={"# paste .env here\nFOO=bar\nexport API_TOKEN=secret"}
          className="w-full border border-border rounded-md px-3 py-2 text-[13px] bg-bg text-fg outline-none focus:border-brand transition-colors placeholder:text-fg-subtle resize-y font-mono"
        />
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              mergeDotenv(pasteText);
              setPasteText("");
            }}
            disabled={!pasteText.trim()}
          >
            Parse into rows
          </Button>
          <label className="inline-flex items-center justify-center min-h-11 sm:min-h-0 text-xs px-2.5 py-1.5 border border-border rounded-md hover:bg-bg-surface text-fg-muted hover:text-fg cursor-pointer">
            Upload .env file
            <input
              type="file"
              accept=".env,text/plain"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) readFile(file);
                e.target.value = "";
              }}
            />
          </label>
          {dragOver && <span className="text-xs text-brand">Drop to parse…</span>}
        </div>
      </div>
    </div>
  );
}
