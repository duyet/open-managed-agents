---
name: debugging
description: Systematically root-cause a bug instead of guessing. Trigger when the user asks to "debug this", "why is this failing", "it's broken", "reproduce this bug", "find the root cause", or pastes an error/stack trace. Reproduce, isolate, form one hypothesis at a time, fix at the root, then add a regression test — never patch the symptom you happened to notice first.
---

# debugging

A bug you can't reproduce is a bug you can't fix — you'll just be guessing and
calling it done. Work the loop: **reproduce → isolate → hypothesize → verify →
fix at the root → prove it stays fixed.**

## 1. Reproduce before anything else

- Get the exact repro steps, input, and environment. "It sometimes fails" is
  not a repro — find what makes it deterministic (specific input, ordering,
  timing, state).
- Confirm you're looking at the *real* failure: run it yourself, read the
  actual error/stack trace/logs, don't work from a paraphrase of the symptom.
- If it won't reproduce locally, get closer to production: same data shape,
  same config, same concurrency — the gap is usually the cause.

## 2. Isolate the failure

- **Bisect.** Binary-search over commits (`git bisect`), inputs (halve the
  dataset until it still fails), or code paths (comment out / short-circuit
  sections) to shrink the failure to the smallest thing that still reproduces
  it.
- **Read the stack trace bottom-up** for exceptions — the throw site, not just
  where it surfaced. For wrong-output bugs, trace the value backwards from
  where it's wrong to where it was last known-correct.
- Separate "where it manifests" from "where it's caused" — a null-pointer
  three calls deep is usually a bad value passed in much earlier.

## 3. Form one hypothesis at a time

- State the hypothesis explicitly ("I think X because Y") before changing
  code. A hypothesis you can't state, you can't falsify.
- Test it with the smallest possible check — a log line, a debugger
  breakpoint, an assertion, a one-line repro script — not a speculative fix.
- If the check disproves the hypothesis, say so and move to the next one.
  Don't quietly keep the disproven assumption baked into later reasoning.

## 4. Instrument, don't guess

- Prefer a debugger or targeted logging at the exact point of divergence over
  scattering `print`/`console.log` everywhere. Each instrumentation point
  should answer a specific question.
- Log actual values, not just "got here" — "reached line 42" tells you
  nothing a stack trace didn't already.
- Remove debug instrumentation before calling the bug fixed; don't leave
  print-driven debugging in the shipped diff.

## 5. Fix at the root cause

- Once you know *why*, fix where the bad state/assumption originates, not
  where it happened to blow up. A null check at the crash site silences the
  symptom; the caller that produced the null is still broken for every other
  path through it.
- If the true fix is large, it's fine to also guard the crash site — but say
  explicitly which is the root fix and which is the guard, don't conflate them.
- Check for the same root cause elsewhere in the codebase — a bug pattern
  rarely occurs exactly once.

## 6. Prove it stays fixed

- Add a test that reproduces the original failure and now passes. If you
  can't write one, you haven't isolated the bug well enough yet.
- Re-run the original repro steps manually too — a passing unit test can still
  miss the real-world trigger.

## Don't

- Don't change multiple things at once "to be safe" — you won't know which
  change (if any) fixed it, and you may have masked the real bug.
- Don't declare victory because the error message went away — confirm the
  *behavior* is now correct, not just that it stopped throwing.
- Don't skip the regression test because the fix "obviously" works — that's
  exactly the bug that comes back in three months.
