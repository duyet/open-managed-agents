# Slack Integration

Two ways to put an OMA agent into Slack:

- **Managed App (recommended)** — the operator creates **one** Slack app, marks
  it distributable, and sets three deployment secrets. End users then install it
  into **any** of their workspaces with a single "Add to Slack" click. No app
  creation, no credential pasting.
- **Bring-your-own-app (BYOA, fallback)** — the user creates their own Slack app
  from a generated manifest and pastes its Client ID / Secret / Signing Secret.
  Always available; used automatically when no managed app is configured.

---

## Operator setup (one-time)

Do this **once** per deployment to enable the one-click flow.

1. **Create the Slack app** at <https://api.slack.com/apps> → *Create New App*.
   Use the manifest emitted by the BYOA wizard as a starting point (it already
   lists the bot/user scopes and subscribed events OMA needs).

2. **Enable public distribution.** In *Manage Distribution* → *Activate Public
   Distribution*. This is what lets the same app be installed into many
   workspaces.

3. **Register the OAuth redirect URL (prefix).** In *OAuth & Permissions* →
   *Redirect URLs*, add:

   ```
   https://<your-gateway-origin>/slack/oauth/pub/
   ```

   Slack does **prefix matching** on redirect URLs, so this one entry covers the
   per-publication callback (`/slack/oauth/pub/<pub_id>/callback`) that every
   managed install uses.

4. **Set the events Request URL (single, fixed).** In *Event Subscriptions* →
   *Request URL*, enter the **app-keyed** URL with the managed app's own id:

   ```
   https://<your-gateway-origin>/slack/webhook/app/<MANAGED_APP_ID>
   ```

   All workspaces share this one events URL — OMA fans each delivery in to the
   right workspace by `team_id`. (Do **not** use a per-publication
   `/slack/webhook/pub/...` URL for the managed app; that shape is for BYOA
   installs where one app == one workspace.)

5. **Set the three deployment secrets** (Cloudflare: `wrangler secret put`;
   Node: env vars) on the integrations gateway:

   | Secret | Where to find it (Slack app admin) |
   |---|---|
   | `SLACK_MANAGED_CLIENT_ID` | *Basic Information* → App Credentials → Client ID |
   | `SLACK_MANAGED_CLIENT_SECRET` | *Basic Information* → App Credentials → Client Secret |
   | `SLACK_MANAGED_SIGNING_SECRET` | *Basic Information* → App Credentials → Signing Secret |

   All three must be set together. If any is missing, `POST
   /slack/publications/start-managed` returns **503** and the Console hides /
   falls back to the BYOA wizard.

That's it. The signing secret is the same for every workspace — OMA verifies
each inbound event against it, then routes by `team_id`.

---

## End-user install (one click)

1. Console → **Integrations → Slack**.
2. Pick agent, environment, and a persona name.
3. Click **Add to Slack**.
4. On Slack's consent screen, choose the workspace and approve.
5. Land back in the Console, connected. The bot is `@`-mentionable immediately.

A user can repeat this to install the same managed app into **multiple**
workspaces — each install creates its own publication, bound to that workspace.
The BYOA "paste your own credentials" steps are skipped entirely when the
managed app is configured.

---

## How multi-workspace routing works

- **Install** — `startManagedInstall` creates a publication shell, stages the
  managed credentials on it, and redirects to Slack OAuth. The callback exchanges
  the code and writes a per-workspace `slack_installations` row keyed by
  `team_id` (bot `xoxb-` + user `xoxp-` tokens, each in its own vault).
- **Inbound events** — every workspace's events hit the single managed events
  URL. The webhook handler verifies the HMAC signature with the managed signing
  secret, then resolves the target installation with
  `installations.findByWorkspace("slack", team_id, "dedicated", <app_id>)` and
  that installation's live publication. This is why one managed app serves many
  workspaces without cross-tenant leakage — a `team_id` maps to exactly one
  dedicated installation.
- **Uninstall / revoke** — `app_uninstalled` and `tokens_revoked` events mark
  the installation `revoked_at` and close its channel sessions. Subsequent
  events for that workspace find no live installation and are dropped. Re-running
  "Add to Slack" for the same workspace mints a fresh installation (newest wins).

### Known limitation

For a **managed** (shared) app, a Slack workspace can hold only one installation
of that app at a time — so a single workspace maps to one OMA
publication/installation. The tenant who completes OAuth owns it. Two tenants
who both want an OMA agent in the *same* workspace should use the BYOA flow with
distinct Slack apps.

---

## BYOA fallback

When no managed app is configured (or the user prefers their own app), the
wizard's **Continue** path generates a Slack app manifest, has the user create
the app and paste its Client ID / Secret / Signing Secret, then completes the
same OAuth callback. Here one app == one workspace, so the webhook URL is
per-publication (`/slack/webhook/pub/<pub_id>`) and no `team_id` fan-in is
needed. See the in-wizard instructions for the step-by-step.
