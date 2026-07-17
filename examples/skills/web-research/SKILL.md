---
name: web-research
description: Research a question on the open web and return a verified, cited answer. Trigger when the user asks to "look this up", "research X", "find out what/whether", "what's the latest on", or any question you can't answer reliably from memory — versions, prices, current events, docs, comparisons. Emphasizes multiple independent sources, checking dates, distinguishing primary from hearsay, and citing what you claim.
---

# web-research

The goal is a **defensible answer**, not the first plausible link. A single
source is a claim; two independent sources agreeing is evidence. Your job is to
turn a question into a small set of trustworthy findings, each traceable to
where it came from.

Use the `web_search` tool to find sources and `web_fetch` to read them in full —
snippets lie by omission; open the page before you quote it.

## Loop

1. **Sharpen the question.** What exact fact settles it? "Is library X
   compatible with Y" → "does X's docs/changelog list Y support, and as of which
   version". A vague question yields vague searches.
2. **Search deliberately.** Start broad to map the terrain, then narrow with
   specific terms, error strings, version numbers, or `site:` filters. Rephrase
   when results are thin — different words surface different sources. Prefer the
   primary source: official docs, the changelog, the standard, the paper, the
   vendor's own page — over a blog summarizing it.
3. **Open and read.** `web_fetch` the promising results. Read enough to confirm
   the claim in context, not just a matching sentence.
4. **Cross-check.** Confirm anything load-bearing against a second independent
   source. Two blogs both citing the same original are *one* source. Watch for
   an answer that everyone copied from one wrong post.
5. **Synthesize with citations.** Answer the question directly, then support it
   with links. Note your confidence and any disagreement you found.

## Judging a source

- **Primary > secondary > hearsay.** Docs and specs beat a tutorial; a tutorial
  beats a forum guess.
- **Check the date.** Software, prices, and events go stale fast. An accurate
  2021 answer can be wrong today. Prefer dated pages; state the date you relied
  on. Beware undated posts and content-farm SEO pages.
- **Who benefits.** A vendor comparing itself to a rival, an affiliate "best of"
  list, marketing dressed as a benchmark — read for bias, corroborate elsewhere.
- **Watch versions.** "How to do X" often changes between major versions. Match
  the answer to the version the user is on.

## Reporting

- **Lead with the answer.** One or two sentences that actually resolve the
  question, then the support.
- **Cite inline.** Attach a URL to each non-obvious claim so the user can
  verify. Prefer a deep link to the exact page over a homepage.
- **State confidence and gaps.** "Confirmed by docs + changelog" vs. "one
  undated blog, unverified". If sources conflict, say so and show both — don't
  silently average them into a false consensus.
- **Don't invent citations.** Never attach a URL you didn't open, and never
  paraphrase a source into saying more than it does. If the web didn't answer
  it, say the web didn't answer it.

## Don't

- Don't answer version/price/current-event questions from memory — search.
- Don't stop at the search snippet; the full page often contradicts it.
- Don't treat volume as truth — ten copies of one rumor is still one rumor.
