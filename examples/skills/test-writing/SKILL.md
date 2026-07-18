---
name: test-writing
description: Write tests that encode why behavior matters, not just what it does — a test that can't fail when the logic breaks is worthless. Trigger when the user asks to "write tests", "add test coverage", "test this function", "TDD this", or when a task's success criteria is fuzzy and a test is the clearest way to pin it down.
---

# test-writing

A test's job is to fail when the behavior it protects breaks. If you can
delete the implementation and the test still passes, it isn't testing
anything. Write tests that verify *intent*, and structure them so a future
reader learns what the code is supposed to do from the test alone.

## Test the behavior, not the implementation

- Assert on outputs, observable side effects, and error contracts — not on
  internal call counts or private state, which change every refactor without
  the behavior changing.
- Name tests after the behavior: `rejects_negative_amount`, not `test1` or
  `testFoo`. A failing test name should tell you what broke without opening
  the file.
- One behavior per test. A test asserting five unrelated things fails
  opaquely — you can't tell which assertion mattered without reading the
  stack trace closely.

## Structure: Arrange, Act, Assert

```
// Arrange — set up the state/inputs this case needs
// Act — call the one thing under test
// Assert — check the one behavior this test is about
```

Keep the "Act" step to a single call where possible. If setup is large and
repeated, extract a fixture/factory — but keep it obvious what varies between
tests, don't hide the interesting input inside a shared helper.

## Cover the edges, not just the happy path

For every function, deliberately walk through:

- **Empty / zero / null / undefined** input.
- **Boundary values** — the first and last valid value, one past each end.
- **Duplicates** where uniqueness is assumed.
- **The error path** — does it fail the way callers expect (right error type,
  right message, no partial state left behind)?
- **Concurrent/repeated calls** where idempotency or ordering matters.

A test suite that only covers the happy path documents the intended usage,
not the guarantees — it will not catch the bug that actually ships.

## The testing pyramid

- **Unit tests** — most of your coverage. Fast, isolated, one function/class,
  deterministic. Mock only at the I/O boundary (network, filesystem, clock,
  external services) — never mock the thing you're actually testing.
- **Integration tests** — fewer. Verify components wired together correctly
  (a real DB, a real HTTP call to an in-process server) — the seam bugs unit
  tests can't see.
- **E2E tests** — fewest. Critical user flows only; expensive and slower to
  diagnose on failure. Don't chase E2E coverage for logic a unit test already
  proves.

## Determinism is not optional

- No real network calls, real clocks, or real randomness in a unit test —
  inject/mock them. A flaky test that "usually passes" trains everyone to
  ignore red CI, which is worse than no test.
- No inter-test ordering dependencies — each test must pass in isolation and
  in any order.
- No `sleep`-based waits for async code — wait on the actual condition/event.

## Don't

- Don't write a test just to raise a coverage number — a test that asserts
  nothing meaningful (or nothing at all) is worse than no test: it looks like
  safety and provides none.
- Don't test third-party library internals — trust the dependency; test your
  usage of it at the boundary if that's the risk.
- Don't over-mock — mocking every collaborator can make a test pass even
  when the real integration is broken. Prefer a real object over a mock
  whenever it's cheap.
