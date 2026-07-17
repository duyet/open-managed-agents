// Shared "how do you want to connect?" chooser — the entry point for every
// provider list page (GitHub / Slack / Linear). Presents the two supported
// paths side by side: OMA's pre-registered managed app (one click, no
// credentials) vs. bringing your own app (full control, existing BYOA
// wizards). Purely presentational — callers own navigation/API calls via
// the two callback props.

interface ConnectModeChooserProps {
  /** Provider display name, e.g. "Slack". */
  provider: string;
  /** null while the managed-availability check is in flight. */
  availability: boolean | null;
  onSelectManaged: () => void;
  onSelectOwn: () => void;
}

export function ConnectModeChooser({
  provider,
  availability,
  onSelectManaged,
  onSelectOwn,
}: ConnectModeChooserProps) {
  const managedDisabled = availability === false;
  return (
    <div className="mb-6">
      <h2 className="text-[12px] font-medium text-fg-muted uppercase tracking-wider mb-2.5">
        How do you want to connect?
      </h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-border bg-bg-surface p-4 flex flex-col">
          <div className="flex items-center gap-2 mb-1.5">
            <h3 className="text-[14px] font-medium text-fg">OMA managed app</h3>
            <span className="inline-flex items-center rounded-full bg-brand/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-brand">
              Recommended · One-click
            </span>
          </div>
          <p className="text-[13px] text-fg-muted flex-1">
            Install {provider}'s OMA app into your workspace/org. No app
            registration, no credentials to paste.
          </p>
          <button
            type="button"
            onClick={onSelectManaged}
            disabled={managedDisabled}
            className="mt-3 inline-flex items-center justify-center gap-1.5 px-3.5 py-2 bg-brand text-brand-fg rounded-md text-[13px] font-medium hover:bg-brand-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
            title={
              managedDisabled
                ? `Not configured on this deployment — ask your admin to set the managed ${provider} app secrets, or bring your own app.`
                : undefined
            }
          >
            Connect
          </button>
          {managedDisabled && (
            <p className="mt-2 text-[12px] text-fg-subtle">
              Not configured on this deployment — ask your admin to set the
              managed {provider} app secrets, or bring your own app.
            </p>
          )}
        </div>

        <div className="rounded-lg border border-border bg-bg-surface p-4 flex flex-col">
          <h3 className="text-[14px] font-medium text-fg mb-1.5">Your own app</h3>
          <p className="text-[13px] text-fg-muted flex-1">
            Register your own {provider} app and keep full control of its
            identity, scopes, and webhook secret.
          </p>
          <button
            type="button"
            onClick={onSelectOwn}
            className="mt-3 inline-flex items-center justify-center gap-1.5 px-3.5 py-2 border border-border rounded-md text-[13px] font-medium hover:border-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
          >
            Connect
          </button>
        </div>
      </div>
    </div>
  );
}
