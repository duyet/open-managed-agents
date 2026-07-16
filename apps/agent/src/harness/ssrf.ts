// The SSRF guard now lives in @duyet/oma-shared (packages/shared/src/ssrf.ts)
// so packages that don't depend on apps/agent — e.g. @duyet/oma-browser-harness
// — can reuse it too. Re-exported here unchanged so existing imports
// (apps/agent's own tools.ts, test/unit/ssrf-guard.test.ts) keep working
// without touching every call site.
export { assertPublicUrl, SsrfBlockedError } from "@duyet/oma-shared";
export type { AssertPublicUrlOptions } from "@duyet/oma-shared";
