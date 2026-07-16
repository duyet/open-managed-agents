// Unit tests for the web_fetch SSRF guard (apps/agent/src/harness/ssrf.ts).
//
// Issue #161: web_fetch fetched model-supplied URLs directly from the
// harness/worker process with no protection against loopback, link-local
// (cloud metadata), RFC1918, or exotic IPv4/IPv6 encodings of the same.
// assertPublicUrl is the shared guard now called at the top of web_fetch
// for every networking mode (see tools-execution.test.ts for the
// integration-level redirect-hop test).

import { describe, it, expect } from "vitest";
import { assertPublicUrl, SsrfBlockedError } from "../../apps/agent/src/harness/ssrf";

describe("assertPublicUrl — schemes", () => {
  it("blocks file:", () => {
    expect(() => assertPublicUrl("file:///etc/passwd")).toThrow();
  });
  it("blocks ftp:", () => {
    expect(() => assertPublicUrl("ftp://example.com/")).toThrow();
  });
  it("blocks gopher:", () => {
    expect(() => assertPublicUrl("gopher://example.com/")).toThrow();
  });
  it("blocks ws:", () => {
    expect(() => assertPublicUrl("ws://example.com/")).toThrow();
  });
  it("blocks wss:", () => {
    expect(() => assertPublicUrl("wss://example.com/")).toThrow();
  });
  it("blocks javascript:", () => {
    expect(() => assertPublicUrl("javascript:alert(1)")).toThrow();
  });
  it("blocks unparseable strings", () => {
    expect(() => assertPublicUrl("not a url")).toThrow();
  });
  it("allows http:", () => {
    expect(() => assertPublicUrl("http://example.com/")).not.toThrow();
  });
  it("allows https:", () => {
    expect(() => assertPublicUrl("https://example.com/")).not.toThrow();
  });
});

describe("assertPublicUrl — localhost", () => {
  it("blocks localhost", () => {
    expect(() => assertPublicUrl("http://localhost/")).toThrow();
  });
  it("blocks localhost with trailing FQDN dot", () => {
    expect(() => assertPublicUrl("http://localhost./")).toThrow();
  });
  it("blocks LOCALHOST regardless of case", () => {
    expect(() => assertPublicUrl("http://LOCALHOST/")).toThrow();
  });
  it("blocks *.localhost subdomains", () => {
    expect(() => assertPublicUrl("http://foo.localhost/")).toThrow();
  });
});

describe("assertPublicUrl — IPv4 loopback, all encodings", () => {
  it.each([
    "http://127.0.0.1/",
    "http://127.1/",
    "http://2130706433/", // decimal
    "http://0x7f000001/", // hex
    "http://017700000001/", // octal
    "http://0177.0.0.1/", // octal octet
    "http://0x7f.0.0.1/", // hex octet
  ])("blocks %s", (url) => {
    expect(() => assertPublicUrl(url)).toThrow();
  });
});

describe("assertPublicUrl — IPv4 blocked ranges", () => {
  it.each([
    ["http://0.0.0.0/", "0.0.0.0/8"],
    ["http://0.0.0.5/", "0.0.0.0/8"],
    ["http://10.0.0.1/", "10.0.0.0/8"],
    ["http://10.255.255.255/", "10.0.0.0/8"],
    ["http://100.64.0.1/", "100.64.0.0/10 CGNAT"],
    ["http://100.127.255.255/", "100.64.0.0/10 CGNAT"],
    ["http://172.16.0.1/", "172.16.0.0/12"],
    ["http://172.31.255.255/", "172.16.0.0/12"],
    ["http://169.254.169.254/", "link-local cloud metadata"],
    ["http://192.168.0.1/", "192.168.0.0/16"],
    ["http://192.0.0.5/", "192.0.0.0/24 reserved"],
    ["http://198.18.0.1/", "198.18.0.0/15 benchmarking"],
    ["http://198.19.255.255/", "198.18.0.0/15 benchmarking"],
  ])("blocks %s (%s)", (url) => {
    expect(() => assertPublicUrl(url)).toThrow();
  });

  it.each([
    "http://172.15.255.255/", // just below 172.16.0.0/12
    "http://172.32.0.1/", // just above 172.16.0.0/12
    "http://100.63.255.255/", // just below 100.64.0.0/10
    "http://100.128.0.0/", // just above 100.64.0.0/10
    "http://192.0.1.5/", // just outside 192.0.0.0/24
    "http://198.17.255.255/", // just below 198.18.0.0/15
    "http://198.20.0.0/", // just above 198.18.0.0/15
    "https://1.1.1.1/",
    "https://8.8.8.8/",
  ])("allows %s (boundary adjacent / genuinely public)", (url) => {
    expect(() => assertPublicUrl(url)).not.toThrow();
  });
});

describe("assertPublicUrl — IPv6", () => {
  it.each([
    ["http://[::1]/", "loopback"],
    ["http://[::]/", "unspecified"],
    ["http://[fe80::1]/", "link-local"],
    ["http://[febf::1]/", "link-local upper bound"],
    ["http://[fc00::1]/", "unique local lower bound"],
    ["http://[fdff::1]/", "unique local upper bound"],
    ["http://[::ffff:127.0.0.1]/", "IPv4-mapped loopback"],
    ["http://[::ffff:169.254.169.254]/", "IPv4-mapped cloud metadata"],
    ["http://[::127.0.0.1]/", "IPv4-compatible (deprecated) loopback"],
  ])("blocks %s (%s)", (url) => {
    expect(() => assertPublicUrl(url)).toThrow();
  });

  it.each([
    "http://[fec0::1]/", // just outside fe80::/10
    "http://[fe00::1]/", // just outside fc00::/7
    "http://[2001:db8::1]/",
    "http://[2606:4700:4700::1111]/", // cloudflare public v6
  ])("allows %s (genuinely public / just outside a blocked range)", (url) => {
    expect(() => assertPublicUrl(url)).not.toThrow();
  });

  it("recurses into an IPv4-mapped address and allows it when the embedded IPv4 is public", () => {
    expect(() => assertPublicUrl("http://[::ffff:8.8.8.8]/")).not.toThrow();
  });
});

describe("assertPublicUrl — allowPrivate escape hatch", () => {
  it("bypasses the loopback check", () => {
    expect(() => assertPublicUrl("http://127.0.0.1/", { allowPrivate: true })).not.toThrow();
  });
  it("bypasses the localhost check", () => {
    expect(() => assertPublicUrl("http://localhost/", { allowPrivate: true })).not.toThrow();
  });
  it("bypasses the link-local/metadata check", () => {
    expect(() => assertPublicUrl("http://169.254.169.254/", { allowPrivate: true })).not.toThrow();
  });
  it("bypasses IPv6 loopback", () => {
    expect(() => assertPublicUrl("http://[::1]/", { allowPrivate: true })).not.toThrow();
  });
  it("still enforces the scheme check even with allowPrivate", () => {
    expect(() => assertPublicUrl("file:///etc/passwd", { allowPrivate: true })).toThrow();
  });
});

describe("assertPublicUrl — return value", () => {
  it("returns a parsed URL instance for an allowed target", () => {
    const result = assertPublicUrl("https://example.com/path?a=1");
    expect(result).toBeInstanceOf(URL);
    expect(result.hostname).toBe("example.com");
  });
});

describe("assertPublicUrl — error type", () => {
  // tools.ts's redirect-hop loop relies on this to distinguish "the guard
  // deliberately rejected this fetch" (hard error, no curl fallback) from
  // a generic network failure (existing fallback-to-curl behavior).
  it("throws SsrfBlockedError specifically, not a plain Error", () => {
    expect(() => assertPublicUrl("http://127.0.0.1/")).toThrow(SsrfBlockedError);
  });
});
