---
name: generate-html
description: Generate self-contained HTML artifacts, reports, and pages. Trigger when the user asks to "make an HTML report", "build a page", "create a dashboard/one-pager", "export this as HTML", or wants a shareable document that opens in any browser. Produces one file with inline CSS/JS, dark/light theming, and a responsive layout — no build step, no CDN.
---

# generate-html

Produce **one `.html` file that renders correctly with no network access**.
Everything inlined: CSS in `<style>`, JS in `<script>`, images as `data:` URIs,
fonts as system stacks. The test: rename the file, disconnect from the network,
open it — it must look identical.

Start from [`template.html`](template.html) and fill it in rather than writing a
page from scratch.

## Hard requirements

- **Self-contained.** No `<link href="https://…">`, no `<script src="//cdn…">`,
  no `@import url(...)`, no remote images. If you need a chart lib or icons,
  inline the source. A page that fetches on load is not done.
- **Responsive.** Fluid layout (flexbox/grid, `max-width` container, relative
  units). Include `<meta name="viewport" content="width=device-width,initial-scale=1">`.
  Wide tables/code go in an `overflow-x:auto` wrapper so the body never scrolls
  sideways on mobile.
- **Dark and light.** Drive all colors from CSS custom properties and provide a
  `@media (prefers-color-scheme: dark)` override. Never hardcode `#fff`
  backgrounds or `#000` text on elements.
- **Valid + accessible.** One `<h1>`, then a sane heading order; semantic tags
  (`<header> <main> <section> <table> <figure>`); `alt` on images; labels on any
  inputs; text contrast >= 4.5:1.

## Layout defaults that look good

- Constrain reading width: `main{ max-width: 72ch; margin-inline:auto; }` for
  prose; `max-width: 1100px` for dashboards.
- Type scale: body `16px/1.6`, system font stack, headings ~1.25 step ratio.
- Spacing on a consistent scale (e.g. 4/8/16/24/32px). Generous whitespace beats
  borders everywhere.
- Cards/tables: subtle border (`1px solid var(--border)`) + small radius, not
  heavy shadows. Zebra-stripe long tables with `tbody tr:nth-child(even)`.
- Numbers in tables: right-align and use `font-variant-numeric: tabular-nums`.

## Reports specifically

- Open with a title, a one-line summary/date, then the key finding — don't bury
  the lede below setup.
- Section with `<h2>`; each section leads with its conclusion, evidence follows.
- Data → a `<table>` or an inline SVG chart (see the `data-viz` skill for chart
  rules); never paste a screenshot of a table you could render as HTML.
- Add a small footer with generation date and source.

## Interactivity (only when it earns its place)

Vanilla JS, inlined, progressive-enhancement style — the content must still read
with JS disabled. Good uses: collapsible sections (`<details>`), client-side
table sort/filter, tab panels, a theme toggle that flips a `data-theme`
attribute and overrides the media query. Keep it to tens of lines; if it needs a
framework, reconsider.

## Ship checklist

- [ ] Opens offline, no console errors, no failed network requests.
- [ ] Looks right in both light and dark (toggle OS theme to check).
- [ ] No horizontal scroll at 375px width.
- [ ] Single `<h1>`, images have `alt`, contrast passes.
- [ ] Written to a `.html` file (e.g. `/workspace/report.html`) — not dumped
      into chat as a wall of markup.
