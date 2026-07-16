import { useEffect, useMemo, useState } from "react";
import { useApi } from "../lib/api";
import { useApiQuery } from "../lib/useApiQuery";
import { Button } from "@/components/ui/button";
import { Logo } from "../components/Logo";

// Browser-side handler for `oma auth login --device`. The CLI prints an
// approval URL + short user_code; the user opens it, authenticates
// (cookie session) + picks one or more workspaces, and approves. The page
// POSTs the selection to /v1/device/approve (minting the tokens server-side)
// and shows an in-page "you can close this tab" state — there is no loopback
// redirect because the CLI polls /v1/device/token itself.
//
// Flow:
//   1. Read ?device_code= & user_code= from the URL.
//   2. If no cookie session → bounce through /login with `next=` here.
//   3. Fetch /v1/me to learn user + memberships.
//   4. Show the user_code prominently + an approval UI (one Approve button
//      when N==1, a checkbox list when N>1).
//   5. POST /v1/device/approve { device_code, tenant_ids }.
//   6. Show a success state (CLI picks the tokens up via polling).

interface MeResponse {
  user: { id: string; email: string; name: string | null } | null;
  tenant: { id: string; name: string };
  tenants: Array<{ id: string; name: string; role: string }>;
}

function tenantDisplayName(t: { id: string; name: string }): string {
  const trimmed = (t.name ?? "").trim();
  if (!trimmed || trimmed === "'s workspace" || trimmed.startsWith("'s ")) {
    return t.id;
  }
  return trimmed;
}

export function CliDevice() {
  const { api } = useApi();
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const deviceCode = params.get("device_code") ?? "";
  const userCode = params.get("user_code") ?? "";

  const [me, setMe] = useState<MeResponse | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [authNeeded, setAuthNeeded] = useState(false);
  const [working, setWorking] = useState(false);
  const [approved, setApproved] = useState(false);
  const [error, setError] = useState<string>("");

  const meQuery = useApiQuery<MeResponse>("/v1/me");
  const loading = meQuery.isLoading;

  useEffect(() => {
    const res = meQuery.data;
    if (!res) return;
    setMe(res);
    const ids = res.tenants.map((t) => t.id);
    setSelected(new Set(ids));
  }, [meQuery.data]);

  useEffect(() => {
    const err = meQuery.error;
    if (!err) return;
    if (/401|Unauthorized/i.test(String((err as Error).message))) {
      setAuthNeeded(true);
    } else {
      setError(String((err as Error).message ?? err));
    }
  }, [meQuery.error]);

  const goLogin = () => {
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `/login?next=${next}`;
  };

  const toggle = (id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(me?.tenants.map((t) => t.id)));

  const approve = async () => {
    if (selected.size === 0 || !me || !deviceCode) return;
    setWorking(true);
    setError("");
    try {
      await api("/v1/device/approve", {
        method: "POST",
        body: JSON.stringify({
          device_code: deviceCode,
          tenant_ids: [...selected],
        }),
      });
      setApproved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setWorking(false);
    }
  };

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center px-4">
      <div className="w-full max-w-md bg-bg-surface border border-border rounded-xl p-8 shadow-sm">
        <div className="flex items-center gap-3 mb-6">
          <Logo size="md" />
          <div>
            <h1 className="font-display text-lg font-semibold">Authorize device</h1>
            <div className="text-xs text-fg-subtle">oma command-line client</div>
          </div>
        </div>

        {loading && <div className="text-sm text-fg-subtle">Checking session…</div>}

        {!loading && error && (
          <div className="bg-danger-subtle border border-danger/30 text-danger text-sm rounded-lg px-4 py-3 mb-4">
            {error}
          </div>
        )}

        {!loading && authNeeded && (
          <>
            <p className="text-sm text-fg-muted mb-4">
              Sign in to authorize the device login.
            </p>
            <Button onClick={goLogin} className="w-full">
              Sign in
            </Button>
          </>
        )}

        {!loading && !authNeeded && !approved && me && (
          <>
            <div className="mb-5">
              <div className="text-xs uppercase tracking-wider text-fg-subtle mb-1">
                Your code
              </div>
              <div className="font-mono text-2xl tracking-[0.3em] text-fg">
                {userCode || "—"}
              </div>
              <p className="text-xs text-fg-subtle mt-2">
                Confirm this matches the code shown in your terminal, then approve.
              </p>
            </div>

            {me.tenants.length === 0 ? (
              <div className="text-sm text-danger mb-4">
                No workspaces found on this account.
              </div>
            ) : me.tenants.length === 1 ? (
              <div className="mb-5">
                <div className="block text-xs uppercase tracking-wider text-fg-subtle mb-2">
                  Workspace
                </div>
                <div className="bg-bg border border-border rounded-lg px-3 py-2.5 text-sm flex items-center gap-2">
                  <div className="w-6 h-6 rounded bg-brand/15 text-brand flex items-center justify-center text-xs font-mono font-bold shrink-0">
                    {tenantDisplayName(me.tenants[0]).charAt(0).toUpperCase() || "·"}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-fg">{tenantDisplayName(me.tenants[0])}</div>
                    <div className="text-[10px] text-fg-subtle font-mono uppercase tracking-wider">
                      {me.tenants[0].role}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="mb-5">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-xs uppercase tracking-wider text-fg-subtle">
                    Workspaces ({selected.size}/{me.tenants.length})
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <button
                      type="button"
                      onClick={selectAll}
                      className="inline-flex items-center min-h-11 sm:min-h-0 px-1 text-fg-muted hover:text-fg underline-offset-2 hover:underline"
                    >
                      All
                    </button>
                  </div>
                </div>
                <div className="border border-border rounded-lg divide-y divide-border max-h-64 overflow-y-auto">
                  {me.tenants.map((t) => {
                    const isSelected = selected.has(t.id);
                    const display = tenantDisplayName(t);
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => toggle(t.id)}
                        className={`w-full text-left px-3 py-2.5 flex items-center gap-3 hover:bg-bg transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] ${isSelected ? "bg-bg/60" : ""}`}
                      >
                        <div
                          className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] ${
                            isSelected ? "bg-brand border-brand" : "bg-bg border-border-strong"
                          }`}
                        >
                          {isSelected && (
                            <svg className="w-3 h-3 text-brand-fg" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          )}
                        </div>
                        <div className="w-7 h-7 rounded bg-brand/15 text-brand flex items-center justify-center text-xs font-mono font-bold shrink-0">
                          {display.charAt(0).toUpperCase() || "·"}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm truncate text-fg">{display}</div>
                          <div className="text-[10px] text-fg-subtle font-mono">
                            {t.id} · {t.role}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <Button
              onClick={approve}
              disabled={working || selected.size === 0 || me.tenants.length === 0}
              className="w-full"
            >
              {working
                ? "Authorizing…"
                : me.tenants.length <= 1
                  ? "Approve"
                  : `Approve ${selected.size} workspace${selected.size === 1 ? "" : "s"}`}
            </Button>
          </>
        )}

        {!loading && approved && (
          <div className="text-center py-4">
            <div className="w-12 h-12 rounded-full bg-brand/15 text-brand flex items-center justify-center mx-auto mb-4">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <h2 className="font-display text-base font-semibold text-fg">Approved</h2>
            <p className="text-sm text-fg-muted mt-1">
              You can close this tab and return to your terminal.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
