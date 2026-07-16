import type { MiddlewareHandler } from "hono";

export type Scope = "boxes:read" | "boxes:write" | "cluster:read" | "sandboxes:read" | "admin";

const AUTH_HEADER = "authorization";
const BEARER_PREFIX = "Bearer ";

function parseScopes(envValue: string | undefined): Set<string> {
  if (!envValue || envValue.trim() === "") return new Set(["admin"]);
  return new Set(envValue.split(",").map((s) => s.trim()).filter(Boolean));
}

function satisfiesAll(tokenScopes: Set<string>, requiredScopes: Scope[]): boolean {
  if (tokenScopes.has("admin")) return true;
  return requiredScopes.every((s) => tokenScopes.has(s));
}

export function authMiddleware(token: string, requiredScopes: Scope[] = []): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header(AUTH_HEADER);
    if (!header || !header.startsWith(BEARER_PREFIX)) {
      return c.json({ error: "unauthorized", message: "Missing or invalid Authorization header" }, 401);
    }
    const provided = header.slice(BEARER_PREFIX.length).trim();
    if (provided !== token) {
      return c.json({ error: "unauthorized", message: "Invalid token" }, 401);
    }

    const tokenScopes = parseScopes(process.env.TOKEN_SCOPES);
    if (!satisfiesAll(tokenScopes, requiredScopes)) {
      return c.json({ error: "forbidden", message: "Insufficient permissions" }, 403);
    }

    await next();
  };
}
