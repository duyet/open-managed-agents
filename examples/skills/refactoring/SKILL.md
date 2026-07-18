---
name: refactoring
description: Restructure code without changing its observable behavior. Trigger when the user asks to "refactor this", "clean this up", "simplify this function", "this is hard to change", "extract this into its own function/module", or "reduce duplication here". Behavior-preserving, test-backed, one small reversible step at a time — never bundled with a feature or bug-fix change.
---

# refactoring

Refactoring changes the shape of code without changing what it does. The
entire point is that behavior stays identical — if a "refactor" changes an
output, a fixed bug, or a public interface, it isn't a refactor anymore, it's
a feature change wearing a refactor's name, and it needs to be reviewed and
tested as one.

## A safety net comes first

- **Tests must exist and pass before you start.** If the code you're touching
  has no tests, write characterization tests first — tests that pin down its
  *current* behavior (including its current bugs, if any) so you have a
  ground truth to refactor against.
- Run the full relevant test suite before starting, so you know your baseline
  is green, and after every step, so a regression is caught the moment it's
  introduced rather than three steps later when it's hard to trace.
- If behavior turns out to be ambiguous or buggy while refactoring, don't fix
  it inline — note it and fix it as a separate, explicitly-labeled change.

## Small, reversible steps

- Each step should be a single mechanical move (see the catalog below) that
  leaves the code in a working, still-green state. If you can't describe the
  step in one sentence, it's too big — split it.
- Commit after each green step. A refactor that's several small commits is
  easy to review and easy to `git revert` one step of if something breaks
  later; one giant "refactor everything" commit is neither.
- Prefer the smallest change that gets you to the next clean state over the
  "ideal" end structure in one leap — you can always take the next step.

## Common moves

- **Extract function/variable** — name a chunk of logic or a magic value so
  intent is visible without re-deriving it.
- **Inline** — the reverse: remove a needless indirection that adds a hop
  without adding clarity.
- **Rename** — the cheapest, highest-leverage refactor there is. A correct
  name removes the need for a comment explaining what the old name didn't say.
- **Replace conditional with guard clause / early return** — flatten nested
  `if`s so the common case reads top-to-bottom instead of buried three levels
  deep.
- **Remove duplication** — but only once you've seen the pattern **three
  times** (rule of three). Abstracting after one or two occurrences usually
  guesses the wrong abstraction and costs more to unwind later than the
  duplication did.
- **Replace conditional with polymorphism/strategy** — when a type-switch or
  long `if/else` chain keeps growing a new branch per feature; skip this if
  there are only two cases and none are coming.

## When not to refactor

- The code works, is rarely touched, and nothing near-term requires changing
  it — refactoring it is speculative cost with no near-term payoff.
- You're mid-way through an unrelated feature or bug fix — finish and ship
  that first; a refactor tangled into a feature diff makes both harder to
  review and impossible to revert independently.
- The "cleaner" structure is only cleaner by personal taste, not by any
  measurable reduction in complexity, duplication, or coupling — matching the
  existing convention beats importing a different one for its own sake.

## Don't

- Don't mix a refactor with a behavior change in the same commit — a reviewer
  (and `git bisect`) needs to be able to trust that a refactor commit changed
  nothing observable.
- Don't refactor code you haven't found the callers of — a "safe" rename or
  signature change that misses a caller is a regression, not a refactor.
- Don't skip re-running tests between steps to save time — that's exactly how
  a multi-step refactor ends up broken with no idea which step did it.
