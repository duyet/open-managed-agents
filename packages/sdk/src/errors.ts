/**
 * Typed error thrown by every SDK call when the server returns
 * non-2xx. Carries the HTTP status, the parsed body when JSON-shaped,
 * and the raw text otherwise — enough to switch on for retry / UI
 * surfacing without re-fetching.
 */
export class OmaError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly raw: string;
  readonly url: string;

  constructor(status: number, raw: string, url: string) {
    let parsed: unknown = undefined;
    try { parsed = JSON.parse(raw); } catch { /* keep raw */ }
    const message = (parsed && typeof parsed === "object" && "error" in parsed
      ? typeof (parsed as { error: unknown }).error === "string"
        ? (parsed as { error: string }).error
        : JSON.stringify((parsed as { error: unknown }).error)
      : raw || `HTTP ${status}`);
    super(`Oma ${status}: ${message}`);
    this.name = "OmaError";
    this.status = status;
    this.body = parsed;
    this.raw = raw;
    this.url = url;
  }
}
