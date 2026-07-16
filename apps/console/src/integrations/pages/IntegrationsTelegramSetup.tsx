import {
  IntegrationSetupCard,
  CopyableCommand,
} from "../components/IntegrationSetupCard";

// Telegram is configured differently from GitHub / Slack / Linear: there is
// no per-tenant install API and no publications table. The bot is wired at
// the deployment level via env secrets (`TELEGRAM_BOT_TOKEN` +
// `TELEGRAM_AGENT_ID`, read by `buildTelegramHandler` in
// apps/integrations/src/routes/telegram/wire.ts), and the webhook is
// registered against Telegram once. So this page is a self-explanatory
// setup guide rather than an OAuth wizard — it renders the same
// what/need/click scaffold every other integration uses.

export function IntegrationsTelegramSetup() {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[820px] mx-auto px-4 sm:px-8 lg:px-10 py-10 lg:py-12">
        <header className="mb-8">
          <h1 className="font-display text-[28px] leading-tight font-semibold tracking-tight text-fg">
            Telegram integration
          </h1>
          <p className="mt-1.5 text-[14px] text-fg-muted max-w-xl">
            Talk to one of your agents from a Telegram chat. Messages you send
            the bot become a session; the agent replies back in-thread.
          </p>
        </header>

        <IntegrationSetupCard
          name="Telegram"
          status="needs-config"
          statusDetail="Deployment-level"
          whatIsThis={
            <>
              A Telegram bot bound to a single agent. Unlike GitHub or Slack,
              Telegram is wired once per deployment via environment secrets —
              not through a per-workspace OAuth install — so a person with
              access to your deployment config sets it up.
            </>
          }
          requirements={[
            {
              label: "A bot token",
              detail: (
                <>
                  created with{" "}
                  <a
                    className="text-brand underline"
                    href="https://t.me/BotFather"
                    target="_blank"
                    rel="noreferrer"
                  >
                    @BotFather
                  </a>{" "}
                  on Telegram
                </>
              ),
            },
            {
              label: "TELEGRAM_AGENT_ID",
              detail: "the agent (agent_…) every chat is routed to",
            },
            {
              label: "TELEGRAM_ENVIRONMENT_ID",
              detail: "sandbox environment the agent runs in",
              optional: true,
            },
            {
              label: "TELEGRAM_VAULT_IDS",
              detail: "comma-separated vault ids to inject credentials",
              optional: true,
            },
          ]}
          steps={[
            {
              title: "Create your bot with BotFather",
              body: (
                <>
                  Open{" "}
                  <a
                    className="text-brand underline"
                    href="https://t.me/BotFather"
                    target="_blank"
                    rel="noreferrer"
                  >
                    @BotFather
                  </a>
                  , send <code className="font-mono text-fg">/newbot</code>, pick
                  a name and username, and copy the token it returns (looks like{" "}
                  <code className="font-mono text-fg">123456:ABC-DEF…</code>).
                </>
              ),
            },
            {
              title: "Bind an agent via deployment secrets",
              body: (
                <>
                  <p>
                    Set the token and the agent to route chats to. On the
                    Cloudflare deployment use <code className="font-mono text-fg">wrangler</code>;
                    on self-host Node add them to your <code className="font-mono text-fg">.env</code>{" "}
                    / <code className="font-mono text-fg">docker compose</code> environment.
                  </p>
                  <CopyableCommand
                    label="Cloudflare (apps/integrations)"
                    value={[
                      "wrangler secret put TELEGRAM_BOT_TOKEN",
                      "wrangler secret put TELEGRAM_AGENT_ID",
                      "# optional:",
                      "wrangler secret put TELEGRAM_ENVIRONMENT_ID",
                      "wrangler secret put TELEGRAM_VAULT_IDS",
                    ].join("\n")}
                  />
                </>
              ),
            },
            {
              title: "Register the webhook with Telegram",
              body: (
                <>
                  <p>
                    Point Telegram at your integrations gateway so updates are
                    delivered. Replace the token and host, then run once:
                  </p>
                  <CopyableCommand
                    value={
                      'curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<your-integrations-host>/telegram/webhook"'
                    }
                  />
                </>
              ),
            },
            {
              title: "Message your bot",
              body: (
                <>
                  Open the bot in Telegram and send it a message. A missing or
                  incomplete config replies with{" "}
                  <code className="font-mono text-fg">telegram bot not configured</code>{" "}
                  (HTTP 503) — recheck the token and{" "}
                  <code className="font-mono text-fg">TELEGRAM_AGENT_ID</code> are
                  both set.
                </>
              ),
            },
          ]}
        >
          <p className="text-[12px] text-fg-muted">
            Note: the bot's chat sessions are kept in-memory per worker isolate,
            which is fine for a single-instance deployment. Idle chats are swept
            automatically — tune with{" "}
            <code className="font-mono text-fg">TELEGRAM_IDLE_TIMEOUT_MS</code>.
          </p>
        </IntegrationSetupCard>
      </div>
    </div>
  );
}
