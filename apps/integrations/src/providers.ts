// Builds and caches all integration providers for a given environment.
//
// Providers are light-weight to construct, but caching avoids rebuilding HTTP
// clients + reading config on every request.
//
// Note on container shape: each provider gets its own per-provider Container
// so the `installations`/`publications` slots resolve to the right backing
// table (linear_*/github_*/slack_*). See wire.ts.

import { LinearProvider, DEFAULT_LINEAR_SCOPES, ALL_CAPABILITIES } from "@duyet/oma-linear";
import {
  GitHubProvider,
  DEFAULT_GITHUB_CAPABILITIES,
  DEFAULT_GITHUB_MCP_URL,
} from "@duyet/oma-github";
import {
  SlackProvider,
  ALL_SLACK_CAPABILITIES,
  DEFAULT_SLACK_BOT_SCOPES,
  DEFAULT_SLACK_USER_SCOPES,
} from "@duyet/oma-slack";
import { TelegramClient } from "@duyet/oma-telegram";
import type { LinearContainer } from "@duyet/oma-linear";
import { buildContainer, buildGitHubContainer, buildSlackContainer } from "./wire";
import type { Env } from "./env";

export interface ProviderBundle {
  linear: LinearProvider;
  github: GitHubProvider;
  slack: SlackProvider;
  telegram: TelegramClient | null;
}

/**
 * Build all providers. The optional `linearContainer` lets callers reuse a
 * pre-built Linear container — handy when a Linear route handler already
 * built one for direct repo access. The github / slack containers are
 * always built fresh because they target different per-provider tables.
 */
export function buildProviders(env: Env, linearContainer?: LinearContainer): ProviderBundle {
  // Trim trailing slash so we can safely concatenate paths.
  const gatewayOrigin = env.GATEWAY_ORIGIN.replace(/\/+$/, "");

  const linear = new LinearProvider(linearContainer ?? buildContainer(env), {
    gatewayOrigin,
    scopes: DEFAULT_LINEAR_SCOPES,
    defaultCapabilities: ALL_CAPABILITIES,
  });

  const github = new GitHubProvider(buildGitHubContainer(env), {
    gatewayOrigin,
    defaultCapabilities: DEFAULT_GITHUB_CAPABILITIES,
    // Override per-deploy via env to point at a self-hosted MCP if needed.
    mcpServerUrl: env.GITHUB_MCP_URL ?? DEFAULT_GITHUB_MCP_URL,
  });

  const slack = new SlackProvider(buildSlackContainer(env), {
    gatewayOrigin,
    botScopes: DEFAULT_SLACK_BOT_SCOPES,
    userScopes: DEFAULT_SLACK_USER_SCOPES,
    defaultCapabilities: ALL_SLACK_CAPABILITIES,
    managedApp:
      env.SLACK_MANAGED_CLIENT_ID && env.SLACK_MANAGED_CLIENT_SECRET && env.SLACK_MANAGED_SIGNING_SECRET
        ? {
            clientId: env.SLACK_MANAGED_CLIENT_ID,
            clientSecret: env.SLACK_MANAGED_CLIENT_SECRET,
            signingSecret: env.SLACK_MANAGED_SIGNING_SECRET,
          }
        : null,
  });

  const telegram = env.TELEGRAM_BOT_TOKEN
    ? new TelegramClient(env.TELEGRAM_BOT_TOKEN)
    : null;

  return { linear, github, slack, telegram };
}
