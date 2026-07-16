import { useState, type ReactNode } from "react";
import { XIcon } from "lucide-react";

import { Combobox } from "./Combobox";

/**
 * ResourcePicker — labeled form controls for selecting platform resources
 * (environment, credential vaults, memory stores).
 *
 * Shared shell + endpoint-backed pickers used by several surfaces: the New
 * Session modal, and the upcoming agent-detail Create Deployment modal.
 * Each picker renders the official Claude-Console field layout:
 *
 *   - A label row: field name (+ "(optional)" when applicable) on the left,
 *     a "Manage <resource> ↗" link on the right (same-tab navigation to the
 *     resource's list page).
 *   - Below it, a select/combobox built on the cursor-paginated `Combobox`
 *     so large lists page in server-side rather than truncating.
 *
 * Three typed subcomponents wrap the shared pieces:
 *   - `EnvironmentPicker`   single-select   → /v1/environments   (/environments)
 *   - `VaultsPicker`        multi-select     → /v1/vaults          (/vaults)
 *   - `MemoryStoresPicker`  multi-select     → /v1/memory_stores   (/memory)
 */

// ── Shared field shell ──────────────────────────────────────────────────

export interface ResourceFieldProps {
  label: string;
  /** Renders "(optional)" next to the label. */
  optional?: boolean;
  /** Where the "Manage … ↗" link points (same-tab). */
  manageHref: string;
  /** Link text, e.g. "Manage environments". */
  manageLabel: string;
  /** Associates the label with the control below for a11y. */
  htmlFor?: string;
  /** Validation message rendered under the control. */
  error?: string;
  children: ReactNode;
}

/**
 * Label row (name + optional tag on the left, Manage link on the right) with
 * the control slotted below and an optional error line. Exported so bespoke
 * fields can reuse the exact same header chrome.
 */
export function ResourceField({
  label,
  optional,
  manageHref,
  manageLabel,
  htmlFor,
  error,
  children,
}: ResourceFieldProps) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label htmlFor={htmlFor} className="text-sm text-fg-muted">
          {label}
          {optional && <span className="text-fg-subtle"> (optional)</span>}
        </label>
        <a href={manageHref} className="text-xs text-brand hover:underline">
          {manageLabel} ↗
        </a>
      </div>
      {children}
      {error && <p className="text-xs text-danger mt-1">{error}</p>}
    </div>
  );
}

// ── Single-select: Environment ──────────────────────────────────────────

interface NamedResource {
  id: string;
  name: string;
}

export interface EnvironmentPickerProps {
  value: string;
  onChange: (id: string) => void;
  /** Field label. Default "Environment". */
  label?: string;
  /** Renders "(optional)" and does not imply required styling. */
  optional?: boolean;
  placeholder?: string;
  error?: string;
  disabled?: boolean;
}

export function EnvironmentPicker({
  value,
  onChange,
  label = "Environment",
  optional,
  placeholder = "Select environment...",
  error,
  disabled,
}: EnvironmentPickerProps) {
  return (
    <ResourceField
      label={label}
      optional={optional}
      manageHref="/environments"
      manageLabel="Manage environments"
      error={error}
    >
      <Combobox<NamedResource>
        value={value}
        onValueChange={(v) => onChange(v)}
        endpoint="/v1/environments"
        getValue={(e) => e.id}
        getLabel={(e) => (
          <span>
            {e.name} <span className="text-fg-subtle text-[12px]">({e.id})</span>
          </span>
        )}
        getTextLabel={(e) => `${e.name} (${e.id})`}
        placeholder={placeholder}
        disabled={disabled}
      />
    </ResourceField>
  );
}

// ── Multi-select core (Vaults, Memory stores) ───────────────────────────

interface MultiResourcePickerProps {
  value: string[];
  onChange: (ids: string[]) => void;
  label: string;
  optional?: boolean;
  manageHref: string;
  manageLabel: string;
  endpoint: string;
  /** Combobox trigger placeholder, e.g. "Add vault...". */
  addPlaceholder: string;
  disabled?: boolean;
}

/**
 * Shared multi-select body: a stack of selected rows (name + remove) plus an
 * "Add …" combobox that excludes already-picked ids. Selected labels are
 * captured on pick (the combobox hands back the full item); ids present in
 * `value` without a captured label fall back to the raw id, mirroring the
 * single-select Combobox's own fallback behavior.
 */
function MultiResourcePicker({
  value,
  onChange,
  label,
  optional,
  manageHref,
  manageLabel,
  endpoint,
  addPlaceholder,
  disabled,
}: MultiResourcePickerProps) {
  // id → display name, captured as the user picks. Preset ids without a
  // known name render as the raw id until (if ever) they're re-picked.
  const [labels, setLabels] = useState<Record<string, string>>({});

  const add = (id: string, item: NamedResource | null) => {
    if (!id || value.includes(id)) return;
    if (item) setLabels((prev) => ({ ...prev, [id]: item.name }));
    onChange([...value, id]);
  };

  const remove = (id: string) => onChange(value.filter((v) => v !== id));

  return (
    <ResourceField
      label={label}
      optional={optional}
      manageHref={manageHref}
      manageLabel={manageLabel}
    >
      <div className="space-y-2">
        {value.length > 0 && (
          <div className="space-y-1">
            {value.map((id) => (
              <div
                key={id}
                className="flex items-center justify-between gap-2 border border-border rounded-md bg-bg-surface px-3 py-2"
              >
                <span className="text-sm text-fg truncate">
                  {labels[id] ?? id}
                  {labels[id] && (
                    <span className="text-fg-subtle font-mono text-xs ml-2">{id}</span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => remove(id)}
                  disabled={disabled}
                  className="inline-flex items-center justify-center size-6 shrink-0 rounded-full text-fg-subtle hover:text-danger hover:bg-danger/10 disabled:opacity-50"
                  aria-label={`Remove ${labels[id] ?? id}`}
                >
                  <XIcon className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
        {/* value="" keeps this a pure adder — picking appends then the
            trigger snaps back to its placeholder. excludeIds hides what's
            already selected. */}
        <Combobox<NamedResource>
          value=""
          onValueChange={(v, item) => add(v, item)}
          endpoint={endpoint}
          getValue={(r) => r.id}
          getLabel={(r) => (
            <span>
              {r.name} <span className="text-fg-subtle text-[12px]">({r.id})</span>
            </span>
          )}
          getTextLabel={(r) => `${r.name} (${r.id})`}
          placeholder={addPlaceholder}
          excludeIds={value}
          disabled={disabled}
        />
      </div>
    </ResourceField>
  );
}

export interface MultiPickerProps {
  value: string[];
  onChange: (ids: string[]) => void;
  label?: string;
  optional?: boolean;
  disabled?: boolean;
}

export function VaultsPicker({
  value,
  onChange,
  label = "Credential vaults",
  optional = true,
  disabled,
}: MultiPickerProps) {
  return (
    <MultiResourcePicker
      value={value}
      onChange={onChange}
      label={label}
      optional={optional}
      manageHref="/vaults"
      manageLabel="Manage vaults"
      endpoint="/v1/vaults"
      addPlaceholder="Add vault..."
      disabled={disabled}
    />
  );
}

export function MemoryStoresPicker({
  value,
  onChange,
  label = "Memory stores",
  optional = true,
  disabled,
}: MultiPickerProps) {
  return (
    <MultiResourcePicker
      value={value}
      onChange={onChange}
      label={label}
      optional={optional}
      manageHref="/memory"
      manageLabel="Manage memory stores"
      endpoint="/v1/memory_stores"
      addPlaceholder="Add memory store..."
      disabled={disabled}
    />
  );
}
