// Zod schemas for `NotificationTarget`. Colocated with the wire types in
// types.ts so the agent config `notify` union is validated wherever agents
// are accepted (http-routes agents CRUD). `webhook`'s `secret_ref` is a
// vault credential id — it must never be inlined, so the schema only allows
// a string ref (the live secret is resolved at dispatch time, not stored
// alongside the agent config).

import { z } from "zod";

const githubCommentTarget = z.object({
  type: z.literal("github_comment"),
  credential_id: z.string(),
  owner: z.string(),
  repo: z.string(),
  issue_number: z.number().int(),
});

const slackMessageTarget = z.object({
  type: z.literal("slack_message"),
  credential_id: z.string(),
  channel: z.string(),
});

const matrixMessageTarget = z.object({
  type: z.literal("matrix_message"),
  credential_id: z.string(),
  homeserver_url: z.string(),
  room_id: z.string(),
});

// No `credential_id` — Telegram auth is a single bot token resolved from
// env (TELEGRAM_BOT_TOKEN), not a per-target vault credential.
const telegramMessageTarget = z.object({
  type: z.literal("telegram_message"),
  chat_id: z.number().int(),
});

const webhookTarget = z.object({
  type: z.literal("webhook"),
  url: z.string().url(),
  secret_ref: z.string().optional(),
  events: z
    .array(z.enum(["idle", "error", "terminated"]))
    .optional(),
});

export const notificationTargetSchema = z.discriminatedUnion("type", [
  githubCommentTarget,
  slackMessageTarget,
  matrixMessageTarget,
  telegramMessageTarget,
  webhookTarget,
]);

export const notificationTargetsSchema = z.array(notificationTargetSchema);

export type NotificationTargetInput = z.infer<typeof notificationTargetSchema>;
