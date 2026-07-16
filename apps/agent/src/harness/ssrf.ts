// SSRF guard for harness-side fetches of model-supplied URLs. Used by
// web_fetch (tools.ts) to validate a URL BEFORE the harness/worker process
// fetches it directly — not sandbox-side execution (the raw-curl fallback
// runs inside the sandbox, which is a separate, sandbox-network-policy
// concern and is left alone here).
//
// Pure string/URL parsing only — no `node:dns`, no `node:net`. This module
// must run unmodified on Cloudflare Workers (workerd), which has neither.
//
// KNOWN LIMITATION — DNS rebinding: this guard validates the URL's literal
// host (IP literal or hostname string) at call time. It cannot prevent a
// PUBLIC hostname from resolving to a PRIVATE address at actual fetch time
// (DNS rebinding), because neither runtime this module targets exposes a
// resolver API that would let us inspect the resolved IP before the
// request is sent. Re-validating every redirect hop (done by the caller,
// not this module) closes the most practical exploitation window; full
// rebinding protection would require a resolve-then-pin proxy layer, which
// is out of scope here. Self-host operators who need a stronger guarantee
// should also firewall egress from the platform process itself (iptables /
// cloud security group) so even a successful rebind has nowhere private to
// land.

export interface AssertPublicUrlOptions {
  /** Skip the private/loopback/link-local/localhost checks (the http(s)
   *  scheme check is still always enforced). Wire this to
   *  WEB_FETCH_ALLOW_PRIVATE for operators who intentionally want internal
   *  reachability from web_fetch. */
  allowPrivate?: boolean;
}

/**
 * Thrown by assertPublicUrl (and reused by callers, e.g. web_fetch's
 * redirect-hop loop, for their own guard-triggered rejections like "too
 * many redirects"). Callers can `instanceof` check this to distinguish "the
 * guard deliberately rejected this fetch" from a generic network failure —
 * the former should surface as an error to the model, never be silently
 * swallowed into a fallback path that might reach the same blocked target
 * by a different route.
 */
export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

/** IPv4 ranges blocked by default. Tuple: [network, prefix length, reason]. */
const BLOCKED_IPV4_RANGES: Array<[string, number, string]> = [
  ["0.0.0.0", 8, "reserved (0.0.0.0/8)"],
  ["10.0.0.0", 8, "private (RFC1918 10.0.0.0/8)"],
  ["100.64.0.0", 10, "carrier-grade NAT (100.64.0.0/10)"],
  ["127.0.0.0", 8, "loopback (127.0.0.0/8)"],
  ["169.254.0.0", 16, "link-local (169.254.0.0/16)"],
  ["172.16.0.0", 12, "private (RFC1918 172.16.0.0/12)"],
  ["192.0.0.0", 24, "reserved (192.0.0.0/24)"],
  ["192.168.0.0", 16, "private (RFC1918 192.168.0.0/16)"],
  ["198.18.0.0", 15, "benchmarking (198.18.0.0/15)"],
];

type Octets = readonly [number, number, number, number];

function octetsToUint32(o: Octets): number {
  return ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
}

function cidrMask(prefixLen: number): number {
  return prefixLen === 0 ? 0 : (0xffffffff << (32 - prefixLen)) >>> 0;
}

/** Reason string if `octets` falls in a blocked IPv4 range, else null. */
function blockedIpv4Reason(octets: Octets): string | null {
  if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return "a malformed IPv4 address";
  const ip = octetsToUint32(octets);
  for (const [base, prefixLen, reason] of BLOCKED_IPV4_RANGES) {
    const baseOctets = base.split(".").map(Number) as unknown as Octets;
    const mask = cidrMask(prefixLen);
    if ((ip & mask) === (octetsToUint32(baseOctets) & mask)) return reason;
  }
  return null;
}

/** Parse a dotted-decimal IPv4 string into 4 octets, or null if not IPv4.
 *  Decimal/octal/hex/short forms (e.g. "2130706433", "0x7f000001",
 *  "127.1") never reach here as such — the WHATWG URL parser already
 *  canonicalizes any of those into this dotted-decimal shape before we
 *  ever read `.hostname`, so a plain regex on the canonical form is
 *  sufficient to catch every input encoding. */
function parseDottedIpv4(hostname: string): Octets | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
}

/** Expand a bracket-stripped IPv6 literal (e.g. "fe80::1",
 *  "::ffff:a9fe:a9fe") into 8 unsigned 16-bit groups, or null if it
 *  doesn't parse. Handles at most one "::" compression — the only shape
 *  the WHATWG URL serializer ever produces in `.hostname` (a dotted-IPv4
 *  suffix, e.g. from "[::127.0.0.1]", is already folded into hex groups
 *  by the time we see this string). */
function expandIpv6(addr: string): number[] | null {
  const parts = addr.split("::");
  if (parts.length > 2) return null;

  const parseGroups = (s: string): string[] => (s === "" ? [] : s.split(":"));
  const head = parseGroups(parts[0]);
  let groups: string[];
  if (parts.length === 2) {
    const tail = parseGroups(parts[1]);
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...new Array(fill).fill("0"), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  const nums: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    nums.push(parseInt(g, 16));
  }
  return nums;
}

/** Reason string if the bracket-stripped IPv6 literal falls in a blocked
 *  range, else null. Recurses into the embedded IPv4 for the two
 *  well-known embedding forms (::ffff:0:0/96 mapped, ::0:0/96
 *  IPv4-compatible/deprecated). Fails CLOSED — an unparseable literal is
 *  treated as blocked rather than silently let through. */
function blockedIpv6Reason(bracketed: string): string | null {
  const addr = bracketed.slice(1, -1); // strip [ ]
  const groups = expandIpv6(addr);
  if (!groups) return "an unparseable IPv6 literal";

  const isZero = (n: number) => n === 0;
  if (groups.slice(0, 7).every(isZero) && groups[7] === 1) return "loopback (::1)";
  if (groups.every(isZero)) return "the unspecified address (::)";
  if ((groups[0] & 0xffc0) === 0xfe80) return "link-local (fe80::/10)";
  if ((groups[0] & 0xfe00) === 0xfc00) return "a unique local address (fc00::/7)";

  // ::ffff:0:0/96 — IPv4-mapped.
  if (groups.slice(0, 5).every(isZero) && groups[5] === 0xffff) {
    const v4: Octets = [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff];
    const reason = blockedIpv4Reason(v4);
    return reason ? `embeds IPv4-mapped ${v4.join(".")} (${reason})` : null;
  }
  // ::0:0/96 — IPv4-compatible (deprecated), e.g. "::127.0.0.1". Checked
  // after the narrower ::1 / :: cases above so those keep priority.
  if (groups.slice(0, 6).every(isZero)) {
    const v4: Octets = [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff];
    const reason = blockedIpv4Reason(v4);
    return reason ? `embeds IPv4-compatible ${v4.join(".")} (${reason})` : null;
  }
  return null;
}

/**
 * Validate that `url` is safe for the HARNESS PROCESS (not the sandbox) to
 * fetch directly. Throws with a human-readable message if the URL should be
 * blocked; returns the parsed URL otherwise.
 *
 * Always enforced, even with `allowPrivate: true`:
 *  - Must parse as a URL.
 *  - Scheme must be http: or https: (blocks file:, ftp:, gopher:, ws:, ...).
 *
 * Enforced unless `allowPrivate: true`:
 *  - Hostname isn't "localhost" / "*.localhost" / empty.
 *  - Hostname isn't an IPv4 literal in a blocked range — covers
 *    decimal/octal/hex/short forms too, since the URL parser itself
 *    canonicalizes those to dotted-decimal before we inspect `.hostname`.
 *  - Hostname isn't an IPv6 literal in a blocked range (loopback,
 *    unspecified, link-local, ULA, or an embedded blocked IPv4 via the
 *    mapped/compatible forms).
 */
export function assertPublicUrl(url: string, opts: AssertPublicUrlOptions = {}): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrfBlockedError(`Blocked URL: "${url}" is not a valid URL`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SsrfBlockedError(`Blocked URL scheme "${parsed.protocol}" on "${url}" — only http/https are allowed`);
  }

  if (opts.allowPrivate) return parsed;

  const hostname = parsed.hostname.replace(/\.$/, ""); // strip a single trailing FQDN dot

  if (hostname === "") {
    throw new SsrfBlockedError(`Blocked URL: "${url}" has no hostname`);
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new SsrfBlockedError(`Blocked URL: "${hostname}" resolves to the local machine`);
  }

  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    const reason = blockedIpv6Reason(hostname);
    if (reason) throw new SsrfBlockedError(`Blocked URL: ${hostname} is ${reason}`);
    return parsed;
  }

  const v4 = parseDottedIpv4(hostname);
  if (v4) {
    const reason = blockedIpv4Reason(v4);
    if (reason) throw new SsrfBlockedError(`Blocked URL: ${hostname} is ${reason}`);
  }

  return parsed;
}
