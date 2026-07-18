---
name: technical-writing
description: Write clear, useful technical documentation — READMEs, architecture decision records, API docs, runbooks, and PR descriptions. Trigger when the user asks to "write docs", "document this", "write a README", "explain this decision", "write release notes", "write an ADR", or "add a docstring". Leads with what the reader needs to do or decide, not a narrated history of how the code was written.
---

# technical-writing

Good technical writing answers the reader's actual question as fast as
possible. Before writing a word, know: who's reading this, and what do they
need to *do* after reading it (run a command, make a decision, understand a
tradeoff)? Structure and cut ruthlessly around that.

## Know the reader and their one question

- **A new user** wants: what is this, how do I get it running, what's the
  first thing to try. Lead there — not with project history or a
  philosophy statement.
- **A maintainer six months from now** wants: why does this work this way,
  what would break if I changed it, what did we already consider and reject.
- **An on-call engineer at 3am** wants: what's broken, how do I check, what's
  the fix — in that order, skimmable in under a minute.

Write for the reader you have, not the one who already knows the context you
do.

## Lead with the answer

Put the most useful sentence first — what it is, what to run, what the
decision was. Explain *why* after, for the reader who needs it, not before,
for the reader who doesn't. If a document buries the key fact in paragraph
four, most readers never reach it.

## README anatomy

1. **One-line description** — what this is, in plain language.
2. **Quickstart** — the fewest steps to a working example. A copy-pasteable
   command block beats three paragraphs of prose.
3. **Core concepts** — only the vocabulary needed to use it correctly.
4. **Configuration/API reference** — link out or collapse if long; don't make
   the reader scroll past it to find the quickstart.
5. **Where to go next** — deeper docs, examples, how to get help.

## ADRs: context, decision, consequences

An architecture decision record exists so nobody re-litigates a settled
tradeoff without knowing what was already considered:

- **Context** — the problem and the constraints that shaped it (not a history
  lesson — just what a reader needs to evaluate whether the decision still
  holds).
- **Decision** — what was chosen, stated plainly in one or two sentences.
- **Alternatives considered** — what else was on the table and why it lost.
  This is the part that saves the next person from proposing the same
  rejected idea.
- **Consequences** — what this makes easier, what it makes harder, what
  becomes technical debt. Be honest about the downsides — an ADR that only
  lists benefits isn't trustworthy.

## Show, don't just tell

- Prefer a runnable example over a paragraph describing behavior — a code
  block a reader can copy-paste and see work builds trust that prose alone
  doesn't.
- Every example should actually run. Test it, don't guess it from memory —
  stale examples erode trust in the whole document.
- Use real, concrete values in examples (`user_id=42`), not placeholders like
  `<value>` everywhere — placeholders force the reader to mentally substitute
  before they can follow along.

## Keep docs close to what they describe, and terse

- Prefer a docstring/comment at the point of use, a README next to the code
  it documents, over a wiki page that drifts the moment the code changes.
- Cut filler words ("simply", "just", "obviously", "in order to") — they add
  length without adding information and can read as condescending when the
  step wasn't simple for the reader.
- One idea per sentence, one topic per paragraph. Short paragraphs are easier
  to skim, and skimming is how most technical docs actually get read.

## Don't

- Don't restate what the code already says clearly — a comment that repeats
  the line above it (`i++  // increment i`) is noise; document *why*, not
  *what*, when the *what* is already obvious from the code.
- Don't let a doc go stale silently — if you change behavior a doc describes,
  update the doc in the same change, not "later."
- Don't reach for marketing language ("blazing fast", "seamlessly") in
  technical docs — state the actual behavior/numbers and let the reader judge.
