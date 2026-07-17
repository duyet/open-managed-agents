---
name: brand-design
description: Apply consistent color, typography, and spacing so an artifact looks designed, not defaulted. Trigger when the user asks to "make it look good/on-brand", "pick colors", "choose fonts", "set up design tokens", "style this page/report/slide", or hands you a brand to match. Covers building a small token set, an accessible color palette, a readable type scale, and a spacing rhythm — then using tokens instead of scattered magic values.
---

# brand-design

Design that reads as *intentional* comes from **a small set of decisions applied
consistently**, not from many one-off choices. Define a handful of tokens —
colors, type sizes, spacing steps — up front, then reference them everywhere. If
the user gave you brand colors/fonts, use those; otherwise pick a restrained set
and commit to it. `tokens.json` is a ready-to-edit starting set.

## Color: few roles, enough contrast

- **A small palette beats a rainbow.** Two or three neutrals (background,
  surface, text), one brand/accent, plus semantic red/amber/green for
  states. More colors read as noise, not richness.
- **Think in roles, not hex.** Name tokens by job — `--color-bg`,
  `--color-text`, `--color-accent` — so the same design works in light and dark
  by swapping values, not rewriting components.
- **Contrast is non-negotiable.** Body text must hit **WCAG AA ≥ 4.5:1** against
  its background (≥ 3:1 for large/heading text and UI borders). Light-gray text
  on white fails — check it. Never rely on color alone to carry meaning (add an
  icon, label, or shape) for colorblind users.
- **Accent sparingly.** The accent marks the one thing you want clicked or read
  first. If everything is accented, nothing is.

## Typography: one or two families, a real scale

- **One typeface does most jobs.** A single good sans (or a sans-for-UI +
  serif-for-body pair) is plenty. Pairing three fonts usually looks worse, not
  richer. System stacks (`system-ui, sans-serif`) are free, fast, and safe.
- **Use a modular scale**, not arbitrary px. Step by a ratio (~1.25) so sizes
  relate: e.g. `12 · 14 · 16 · 20 · 25 · 31 · 39`. Body around `16px`; don't go
  below `14px` for anything meant to be read.
- **Weight and size make hierarchy** — heading vs body should be obvious at a
  glance. Two or three weights (e.g. 400/600/700) is enough.
- **Line length and height.** Aim for **~60–75 characters per line**
  (`max-width: ~65ch`) and line-height **~1.5 for body**, tighter (~1.2) for
  large headings. Long full-width lines are the most common readability killer.

## Spacing: one rhythm, applied everywhere

- **Space on a scale** (a 4px or 8px base: `4 · 8 · 12 · 16 · 24 · 32 · 48 · 64`).
  Every margin, padding, and gap is a step on that scale — never a random `13px`.
  Consistent spacing is most of what makes a layout feel tidy.
- **Whitespace is a feature.** Generous, consistent gaps separate groups and
  give the eye somewhere to rest. Cramped is the default failure mode; fix it
  with more space, not more borders.
- **Align to a grid.** Shared left edges and consistent gutters read as ordered;
  slightly-off alignments read as broken even when nothing's wrong.

## Tokenize, then reference

Put the decisions in one place and point everything at it — CSS custom
properties are the simplest vehicle:

```css
:root {
  --color-bg: #ffffff;   --color-text: #1a1a1a;   --color-accent: #2563eb;
  --font-sans: system-ui, -apple-system, "Segoe UI", sans-serif;
  --text-base: 1rem;     --text-lg: 1.25rem;      --text-xl: 1.563rem;
  --space-2: 0.5rem;     --space-4: 1rem;         --space-6: 1.5rem;
  --radius: 0.5rem;
}
@media (prefers-color-scheme: dark) {
  :root { --color-bg: #0f0f0f; --color-text: #f5f5f5; --color-accent: #60a5fa; }
}
```

Then components use `var(--space-4)`, `var(--color-accent)` — no magic numbers.
Changing the brand becomes editing one block. `tokens.json` holds the same set
as portable JSON you can generate CSS/Tailwind config from.

## Don't

- Don't scatter raw hex and px through the markup — one drifted value and it
  looks off. Reference tokens.
- Don't ship low-contrast text to look "subtle" — subtle and unreadable are
  different things; verify AA.
- Don't add a third font or a fifth accent color to add interest — restraint
  reads as polish.
