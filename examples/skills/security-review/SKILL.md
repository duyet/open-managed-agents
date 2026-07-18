---
name: security-review
description: Audit code or infrastructure for exploitable vulnerabilities using an OWASP-style checklist. Trigger when the user asks to "security review this", "is this safe to ship", "audit for vulnerabilities", "check for security issues", "pentest this", or before merging code that touches auth, payments, file uploads, or raw user input. Threat-models the surface first, then works a checklist by severity — reports exploit scenarios, not vague warnings.
---

# security-review

A security review answers: **what can an attacker do, and what does it cost
them?** Vague "this could be more secure" notes don't help anyone triage. For
every finding, state the concrete exploit scenario and its impact, ranked by
what actually gets exploited in practice.

## 1. Threat-model the surface first

- **Who's the attacker?** Anonymous internet user, authenticated user acting
  against another user's data, or an insider/compromised dependency — the
  bar for "exploitable" differs for each.
- **What's the entry point?** Every place untrusted data enters: HTTP request
  bodies/headers/query params, file uploads, webhook payloads, queue
  messages, CLI args, env vars from a less-trusted process, LLM tool output.
- **What's worth stealing or breaking?** Credentials, PII, payment data,
  ability to impersonate another user, ability to run arbitrary code.

## 2. Injection — untrusted input reaching a sink

- **SQL/NoSQL injection** — string-concatenated queries. Fix: parameterized
  queries / prepared statements, never build a query by interpolating input.
- **Command injection** — user input reaching a shell (`exec`, `system`,
  backticks). Fix: avoid the shell entirely (argv arrays, not a shell string);
  allowlist if you truly need a shell.
- **Path traversal** — user-controlled filenames/paths reaching the
  filesystem (`../../etc/passwd`). Fix: resolve and verify the path stays
  under an allowed root; never trust a client-supplied path segment.
- **SSRF** — user-controlled URLs fetched server-side (webhooks, URL preview,
  "fetch this link"). Fix: allowlist destinations, block internal/link-local
  IP ranges, disable redirects to internal hosts.
- **Template/deserialization injection** — user input reaching `eval`,
  `pickle.loads`, unsafe YAML load, or a template engine's raw-render. Fix:
  never `eval` untrusted input; use safe (non-executing) deserializers.
- **XSS** — user content rendered as HTML/JS without escaping. Fix: escape by
  default (framework auto-escaping), never build HTML via string
  concatenation of user input.

## 3. AuthN and AuthZ

- **Authentication ≠ authorization.** A logged-in user is not automatically
  entitled to touch *this* resource — every route that takes an ID
  (`/orders/{id}`) must check the caller owns/can-access that specific ID
  (IDOR is the single most common finding in real audits).
- Session tokens: sufficiently random, `HttpOnly` + `Secure` cookies (or
  equivalent for non-cookie tokens), rotated on privilege change, invalidated
  on logout.
- Password/secret comparisons use constant-time equality, never `==`/`===`.
- Privilege boundaries (admin routes, internal-only endpoints) are enforced
  server-side — a hidden UI element is not access control.

## 4. Secrets and data exposure

- No secrets in source, commit history, logs, error messages, or client
  bundles — grep the diff for API keys, tokens, private keys, connection
  strings before approving.
- Error responses to the client never include stack traces, SQL, internal
  hostnames, or file paths.
- Encrypt sensitive data at rest and in transit; scope credentials to the
  minimum they need (a read-only token where write isn't required).

## 5. Dependencies and supply chain

- New/bumped dependencies: check for known CVEs, and that the version bump
  wasn't to an unexpectedly different major with new maintainers.
- Don't add a dependency for something the standard library already does
  well — every dependency is attack surface you didn't write.

## 6. Report

For each finding: **severity** (critical/high/medium/low, by exploitability ×
impact) → **location** (`file:line`) → **exploit scenario** (concrete: "an
attacker sends X, causing Y") → **fix**. Lead with anything remotely
exploitable by an anonymous or low-privilege user; note hardening-only items
separately so they don't block a merge that's already safe.

## Don't

- Don't report a finding without a plausible exploit path — "in theory this
  could be misused" without a concrete scenario just creates noise.
- Don't stop at the first vulnerability class you find — a single input often
  has multiple paths to a sink; check all of them.
- Don't fix silently and skip the report — the team needs to know what was
  wrong and why, so the same mistake isn't repeated elsewhere.
