// Unified integrations hub (issue #92).
//
// One landing page listing every available integration with a consistent
// "Connect" flow, a connected-state summary, and a one-click way into each
// provider's workspace to manage or disconnect. Providers that support an
// OAuth-app handshake surface a direct Connect button; token-only providers
// (Telegram, Matrix) point at their setup instead — same card, same UX.
//
// Connection status is read from each provider's existing
// `list*` endpoints via IntegrationsApi so the hub reflects live installs
// without a new backend endpoint.

import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { IntegrationsApi } from "../api/client";

const api = new IntegrationsApi();

interface ProviderCard {
  id: string;
  name: string;
  blurb: string;
  /** Route to the provider's list/manage page. */
  href: string;
  /** How the user connects: OAuth-app one-click, or a token/manifest setup. */
  connectKind: "oauth" | "token";
  /** Resolve current connection count. null when the provider has no list API
   *  wired yet (Telegram/Matrix) — the card still renders, just without a
   *  count. */
  countConnections: (() => Promise<number>) | null;
}

const PROVIDERS: ProviderCard[] = [
  {
    id: "linear",
    name: "Linear",
    blurb: "Make agents teammates in Linear — assign issues, @mention, push status.",
    href: "/integrations/linear",
    connectKind: "oauth",
    countConnections: async () => (await api.linear.listInstallations()).length,
  },
  {
    id: "github",
    name: "GitHub",
    blurb: "Let agents open PRs, review code, and respond to issues on your repos.",
    href: "/integrations/github",
    connectKind: "oauth",
    countConnections: async () => (await api.github.listInstallations()).length,
  },
  {
    id: "slack",
    name: "Slack",
    blurb: "Bring agents into channels — mention them, get status back in-thread.",
    href: "/integrations/slack",
    connectKind: "oauth",
    countConnections: async () => (await api.slack.listInstallations()).length,
  },
  {
    id: "telegram",
    name: "Telegram",
    blurb: "Talk to agents from a Telegram chat via a bot token.",
    href: "/integrations/telegram",
    connectKind: "token",
    countConnections: null,
  },
  {
    id: "matrix",
    name: "Matrix",
    blurb: "Connect agents to a Matrix room on your own homeserver.",
    href: "/integrations/matrix",
    connectKind: "token",
    countConnections: null,
  },
];

export function IntegrationsHub() {
  const [counts, setCounts] = useState<Record<string, number | null>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [params] = useSearchParams();

  // Banner state driven by the unified OAuth callback redirect
  // (?connected=<provider> on success, ?connect_error=<code>&provider=<id>).
  const connected = params.get("connected");
  const connectError = params.get("connect_error");
  const errorProvider = params.get("provider");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const entries = await Promise.all(
          PROVIDERS.map(async (p) => {
            if (!p.countConnections) return [p.id, null] as const;
            try {
              return [p.id, await p.countConnections()] as const;
            } catch {
              // A provider's list endpoint failing shouldn't blank the hub.
              return [p.id, null] as const;
            }
          }),
        );
        if (!cancelled) setCounts(Object.fromEntries(entries));
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[1100px] mx-auto px-4 sm:px-8 lg:px-10 py-10 lg:py-12">
        <header className="mb-8">
          <h1 className="font-display text-[28px] leading-tight font-semibold tracking-tight text-fg">
            Integrations
          </h1>
          <p className="mt-1.5 text-[14px] text-fg-muted max-w-xl">
            Connect your agents to the tools your team already uses. Pick a service and
            connect it — credentials are stored encrypted in your vault, never in the sandbox.
          </p>
        </header>

        {connected && (
          <div className="mb-6 rounded-lg border border-success/30 bg-success-subtle px-4 py-3 text-[13px] text-success">
            Connected <strong className="capitalize">{connected}</strong> successfully.
          </div>
        )}
        {connectError && (
          <div className="mb-6 rounded-lg border border-danger/30 bg-danger-subtle px-4 py-3 text-[13px] text-danger">
            Couldn't connect{errorProvider ? ` ${errorProvider}` : ""}: {connectError}. Please try again.
          </div>
        )}
        {error && (
          <div className="mb-6 rounded-lg border border-danger/30 bg-danger-subtle px-4 py-3 text-[13px] text-danger">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {PROVIDERS.map((p) => {
            const count = counts[p.id];
            const isConnected = typeof count === "number" && count > 0;
            return (
              <div
                key={p.id}
                className="flex flex-col rounded-xl border border-border bg-bg-surface p-5"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-[16px] font-semibold text-fg">{p.name}</h2>
                    <p className="mt-1 text-[13px] text-fg-muted">{p.blurb}</p>
                  </div>
                  {isConnected ? (
                    <span className="shrink-0 inline-flex items-center gap-1.5 rounded-full bg-success-subtle px-2 py-0.5 text-[11px] font-medium text-success">
                      <span className="w-1.5 h-1.5 rounded-full bg-success" />
                      {count} connected
                    </span>
                  ) : (
                    <span className="shrink-0 inline-flex items-center gap-1.5 rounded-full bg-bg px-2 py-0.5 text-[11px] font-medium text-fg-subtle">
                      Not connected
                    </span>
                  )}
                </div>
                <div className="mt-4 flex items-center gap-3">
                  <Link
                    to={p.href}
                    className="inline-flex items-center rounded-lg bg-fg px-3 py-1.5 text-[13px] font-medium text-bg hover:opacity-90"
                  >
                    {isConnected ? "Manage" : p.connectKind === "oauth" ? "Connect" : "Set up"}
                  </Link>
                  {isConnected && (
                    <Link
                      to={p.href}
                      className="text-[13px] text-fg-muted hover:text-fg underline underline-offset-2"
                    >
                      Disconnect
                    </Link>
                  )}
                  {loading && !isConnected && (
                    <span className="text-[12px] text-fg-subtle">Checking…</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
