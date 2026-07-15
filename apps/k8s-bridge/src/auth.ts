import type { MiddlewareHandler } from "hono";

const AUTH_HEADER = "authorization";
const BEARER_PREFIX = "Bearer ";

export function authMiddleware(token: string): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header(AUTH_HEADER);
    if (!header || !header.startsWith(BEARER_PREFIX)) {
      return c.json({ error: "unauthorized", message: "Missing or invalid Authorization header" }, 401);
    }
    const provided = header.slice(BEARER_PREFIX.length).trim();
    if (provided !== token) {
      return c.json({ error: "unauthorized", message: "Invalid token" }, 401);
    }
    await next();
  };
}
