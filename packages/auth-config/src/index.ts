// Build a better-auth instance with the OMA-shared config.
//
// CF passes a drizzle-adapter wrapping MAIN_DB; Node passes either a
// better-sqlite3 db or a pg.Pool — kysely-adapter inside better-auth
// detects the dialect from the shape (`aggregate in db` → SqliteDialect,
// `connect in db` → PostgresDialect).
//
// Email-OTP / sendResetPassword / sendVerificationEmail mount only when
// the caller passes a non-null `sender` — preserves P0-followup default-off
// behavior. The tenant-create databaseHook lives here so the same
// "sign up auto-creates a workspace" flow runs on either runtime.

import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins";
import type { EmailSender } from "@duyet/oma-email";
import type { SqlClient } from "@duyet/oma-sql-client";

export interface BuildBetterAuthOpts {
  /** Driver handle. better-sqlite3 Database, pg.Pool, or a drizzle adapter
   *  (CF). better-auth's kysely-adapter detects the dialect; CF callers
   *  pass `drizzleAdapter(db, { provider: "sqlite", schema })` — that
   *  satisfies the same `database` slot. */
  database: unknown;
  /** Cookie signing + token HMAC. Required in prod; main-node mints a
   *  per-process random one when omitted (callers SHOULD warn). */
  secret: string;
  /** Public origin (used for redirect URLs + cookie domain). */
  baseURL?: string;
  /** Email sender; null disables every email-bearing better-auth flow.
   *  CF prod always passes a real sender; self-host without SMTP passes
   *  null. */
  sender: EmailSender | null;
  /** Optional Google OAuth. */
  googleClientId?: string;
  googleClientSecret?: string;
  /** Optional GitHub OAuth. */
  githubClientId?: string;
  githubClientSecret?: string;
  /** When true, sign-up requires email verification before the user is
   *  signed in. Default: false on self-host (no SMTP path), true on CF prod. */
  requireEmailVerify?: boolean;
  /** Cross-subdomain cookie domain (e.g. ".oma.duyet.net"). Skip for default
   *  per-host scoping. */
  cookieDomain?: string;
  /** Idempotent ensure-tenant; called from databaseHooks.user.create.after.
   *  Runtimes pass their own implementation: CF writes to the legacy
   *  `tenant` + `membership` + `tenant_shard` tables; Node writes to the
   *  packages/schema tenant tables only (no shard router). */
  ensureTenant: (user: {
    id: string;
    name?: string | null;
    email?: string | null;
  }) => Promise<unknown>;
  /** Optional drizzle-adapter pre-built by CF; pass `database` instead
   *  on Node. Ignored when not provided. */
  drizzleProvider?: "sqlite" | "pg";
}

export type BetterAuth = ReturnType<typeof betterAuth>;

function otpEmailHtml(code: string, label: string): string {
  return [
    '<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:32px">',
    `<h2 style="margin:0 0 16px">${label}</h2>`,
    `<p style="font-size:32px;letter-spacing:8px;font-weight:bold;margin:24px 0">${code}</p>`,
    '<p style="color:#666;font-size:14px">This code expires in 5 minutes. If you did not request this, ignore this email.</p>',
    "</div>",
  ].join("");
}

export function buildBetterAuth(opts: BuildBetterAuthOpts) {
  const socialProviders: Record<string, unknown> = {};
  if (opts.googleClientId && opts.googleClientSecret) {
    socialProviders.google = {
      clientId: opts.googleClientId,
      clientSecret: opts.googleClientSecret,
    };
  }
  if (opts.githubClientId && opts.githubClientSecret) {
    socialProviders.github = {
      clientId: opts.githubClientId,
      clientSecret: opts.githubClientSecret,
    };
  }

  const sender = opts.sender;
  const requireVerify = !!opts.requireEmailVerify;

  const plugins: unknown[] = [];
  if (sender) {
    plugins.push(
      emailOTP({
        otpLength: 6,
        expiresIn: 300,
        sendVerificationOnSignUp: requireVerify,
        async sendVerificationOTP({ email, otp, type }) {
          const labels: Record<string, string> = {
            "sign-in": "Your sign-in code",
            "email-verification": "Verify your email",
            "forget-password": "Your password reset code",
          };
          const label = labels[type] ?? "Your verification code";
          await sender.send({
            to: email,
            subject: `${label} — openma`,
            html: otpEmailHtml(otp, label),
            text: `${label}: ${otp}`,
          });
        },
      }),
    );
  }

  const emailVerification = sender
    ? {
        sendVerificationEmail: async ({ user, url }: { user: { email: string }; url: string }) => {
          await sender.send({
            to: user.email,
            subject: "Verify your email — openma",
            html: `<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:32px"><h2>Verify your email</h2><p>Click the button below to verify your email address.</p><a href="${url}" style="display:inline-block;padding:12px 24px;background:#111;color:#fff;text-decoration:none;border-radius:6px;margin:16px 0">Verify email</a></div>`,
            text: `Verify your email: ${url}`,
          });
        },
        sendOnSignUp: true,
        autoSignInAfterVerification: true,
      }
    : undefined;

  const sendResetPassword = sender
    ? async ({ user, url }: { user: { email: string }; url: string }) => {
        await sender.send({
          to: user.email,
          subject: "Reset your password — openma",
          html: `<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:32px"><h2>Reset your password</h2><a href="${url}" style="display:inline-block;padding:12px 24px;background:#111;color:#fff;text-decoration:none;border-radius:6px;margin:16px 0">Reset password</a></div>`,
          text: `Reset your password: ${url}`,
        });
      }
    : undefined;

  return betterAuth({
    basePath: "/auth",
    secret: opts.secret,
    baseURL: opts.baseURL,
    database: opts.database as never,
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: requireVerify,
      ...(sendResetPassword ? { sendResetPassword } : {}),
    },
    ...(emailVerification ? { emailVerification } : {}),
    plugins: plugins as never,
    socialProviders,
    trustedOrigins: opts.baseURL ? [opts.baseURL] : ["*"],
    ...(opts.cookieDomain
      ? {
          advanced: {
            crossSubDomainCookies: {
              enabled: true,
              domain: opts.cookieDomain,
            },
            defaultCookieAttributes: {
              domain: opts.cookieDomain,
              sameSite: "lax" as const,
              secure: true,
            },
          },
        }
      : {}),
    user: {
      additionalFields: {
        tenantId: { type: "string", required: false },
        role: { type: "string", required: false, defaultValue: "member" },
      },
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user: { id: string; name?: string | null; email?: string | null }) => {
            try {
              await opts.ensureTenant(user);
            } catch (err) {
              // Don't block sign-up on tenant creation — auth middleware's
              // self-heal path retries on first authenticated request.
              console.error("[auth-config] ensureTenant hook failed:", err);
            }
          },
        },
      },
    },
  });
}

/** Run an idempotent ensure-tenant against an arbitrary SqlClient (the
 *  Node-style flow). Used by both apps/main-node's auth-config hook and
 *  the auth-middleware self-heal path. CF runs an analogous helper that
 *  also assigns a shard — see apps/main/src/auth-config.ts:ensureTenant. */
export async function ensureTenantSqlite(
  sql: SqlClient,
  userId: string,
  userName: string | null | undefined,
  userEmail: string | null | undefined,
): Promise<string> {
  const existing = await sql
    .prepare(
      `SELECT tenant_id FROM membership WHERE user_id = ? ORDER BY created_at ASC, tenant_id ASC LIMIT 1`,
    )
    .bind(userId)
    .first<{ tenant_id: string }>();
  if (existing) return existing.tenant_id;

  const tenantId = `tn_${randomHex(16)}`;
  const now = Date.now();
  const trimmedName = (userName ?? "").trim();
  const emailPrefix = (userEmail ?? "").split("@")[0]?.trim() ?? "";
  const display = trimmedName || emailPrefix || "User";
  const tenantName = `${display}'s workspace`;

  await sql
    .prepare(`INSERT INTO "tenant" (id, name, "createdAt", "updatedAt") VALUES (?, ?, ?, ?)`)
    .bind(tenantId, tenantName, now, now)
    .run();

  await sql
    .prepare(
      `INSERT INTO "membership" (user_id, tenant_id, role, created_at)
       VALUES (?, ?, 'owner', ?)
       ON CONFLICT (user_id, tenant_id) DO NOTHING`,
    )
    .bind(userId, tenantId, now)
    .run();

  // Re-read in case a concurrent caller raced.
  const final = await sql
    .prepare(
      `SELECT tenant_id FROM membership WHERE user_id = ? ORDER BY created_at ASC, tenant_id ASC LIMIT 1`,
    )
    .bind(userId)
    .first<{ tenant_id: string }>();
  return final?.tenant_id ?? tenantId;
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface TrustedProxyResolvedSession {
  userId: string;
  email: string;
  name: string;
}

/**
 * Resolve-or-create a better-auth "user" row for a trusted-proxy-verified
 * identity. This function performs ZERO validation of the caller's
 * authority to claim the identity — it must only ever be invoked after
 * @duyet/oma-auth's checkTrustedProxyGuard has already passed
 * for the current request (see that package's trusted-proxy.ts for the
 * full threat model). Lookup/creation key is `email`, the "user" table's
 * unique column.
 *
 * `dialect` controls timestamp + boolean representation: Postgres columns
 * are TIMESTAMPTZ/BOOLEAN (JS Date/boolean), sqlite columns are
 * INTEGER ms-epoch / 0-1 (JS number) — see packages/schema's
 * applyBetterAuthSchema for the DDL both branches target.
 */
export async function resolveTrustedProxyUser(
  sql: SqlClient,
  dialect: "sqlite" | "postgres",
  identity: { subject: string; email: string; name: string },
): Promise<TrustedProxyResolvedSession> {
  const email = identity.email.trim().toLowerCase();
  if (!email) {
    throw new Error("resolveTrustedProxyUser: identity has no usable email");
  }

  const existing = await sql
    .prepare(`SELECT "id", "email", "name" FROM "user" WHERE "email" = ?`)
    .bind(email)
    .first<{ id: string; email: string; name: string }>();
  if (existing) {
    return { userId: existing.id, email: existing.email, name: existing.name };
  }

  const userId = `usr_${randomHex(16)}`;
  const name = identity.name.trim() || email.split("@")[0] || "User";
  const now: number | Date = dialect === "postgres" ? new Date() : Date.now();
  const emailVerified: boolean | number = dialect === "postgres" ? true : 1;

  await sql
    .prepare(
      `INSERT INTO "user"
         ("id", "email", "emailVerified", "name", "tenantId", "role", "createdAt", "updatedAt")
       VALUES (?, ?, ?, ?, NULL, 'member', ?, ?)
       ON CONFLICT ("email") DO NOTHING`,
    )
    .bind(userId, email, emailVerified, name, now, now)
    .run();

  // Re-read: either our own insert landed, or a concurrent request won a
  // create-race for the same email — either way there is now exactly one
  // "user" row for it.
  const final = await sql
    .prepare(`SELECT "id", "email", "name" FROM "user" WHERE "email" = ?`)
    .bind(email)
    .first<{ id: string; email: string; name: string }>();
  if (!final) {
    throw new Error(`resolveTrustedProxyUser: failed to create or find user for ${email}`);
  }
  return { userId: final.id, email: final.email, name: final.name };
}
