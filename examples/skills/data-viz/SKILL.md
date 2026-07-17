---
name: data-viz
description: Produce clear, accessible charts and dashboards. Trigger when the user asks to "make a chart", "visualize", "plot", "graph", "build a dashboard", or turn numbers/CSV/query results into a picture. Covers chart-type choice, color and accessibility rules, and shipping the result as one self-contained HTML file the user can open in any browser.
---

# data-viz

Turn data into a visualization that reads correctly in five seconds. Default
output is a **single self-contained HTML file** (no CDN, no external assets) so
it opens anywhere and survives being emailed or dropped into an artifact.

## Workflow

1. **Know the data first.** Inspect shape before drawing: how many rows, how
   many series, are the categories ordered, is there a time axis, what are the
   units and ranges. Never plot a column you haven't looked at.
2. **Pick the chart from the question, not the data type** (see heuristics).
3. **Render to self-contained HTML.** Inline everything. Prefer hand-written
   SVG for <= a few hundred marks; reach for a bundled JS lib only when you
   need interactivity, and inline the library source.
4. **Check it renders** — open/convert it, confirm axes, legend, and labels are
   present and not overlapping. A chart with a clipped legend is a bug.

## Chart-choice heuristics

| The question is about… | Use | Avoid |
|---|---|---|
| Comparing values across categories | horizontal bar (sort by value) | pie beyond 2-3 slices |
| A part-to-whole split | stacked bar, or a single 100% bar | 3-D anything |
| Change over time | line (continuous) / bar (few discrete periods) | line for unordered categories |
| Relationship between two numbers | scatter | dual y-axes (usually misleading) |
| Distribution of one variable | histogram / box plot | bar chart of raw values |
| Ranking | sorted bar, or a small table | radar/spider |
| One key number | big number + a sparkline of context | a gauge |

Rules that override the table:
- **Sort bars by value**, not alphabetically, unless the category has a natural
  order (age buckets, weekdays, months).
- **Bar/area y-axes start at 0.** Line charts may crop the axis to show change,
  but say so.
- More than ~7 series on one chart = small multiples instead of a rainbow.
- If a table answers the question better than a chart (few precise numbers),
  ship the table.

## Color and accessibility

- Use a **colorblind-safe categorical palette** — see [`palette.md`](palette.md)
  for exact hex values. Do not invent random colors per series.
- Never encode meaning by color alone: also vary label, position, or use direct
  labels on the marks. ~8% of men can't distinguish red/green.
- Text/background contrast >= 4.5:1; axis and gridline text >= 3:1. Gridlines
  should be faint (light gray), never darker than the data.
- Support dark and light: drive colors from CSS variables and a
  `prefers-color-scheme` media query so the chart isn't a white box on a dark
  page.
- Every chart needs: a title stating the takeaway (not "Chart 1"), labeled axes
  with units, a legend or direct labels, and a source/date note when relevant.

## Self-contained HTML shell

Emit one `.html` file. Inline CSS in `<style>`, inline any JS in `<script>`,
embed images as `data:` URIs. Structure:

```html
<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Revenue by region — 2026 Q2</title>
<style>
  :root { --fg:#1a1a1a; --bg:#fff; --grid:#e5e5e5; }
  @media (prefers-color-scheme: dark){ :root{ --fg:#e8e8e8; --bg:#111; --grid:#333; } }
  body{ background:var(--bg); color:var(--fg); font:15px/1.5 system-ui,sans-serif; margin:2rem; }
  svg text{ fill:var(--fg); } .grid{ stroke:var(--grid); }
  figure{ max-width:900px; margin:0 auto; } svg{ width:100%; height:auto; }
</style>
<figure>
  <figcaption><h1>Revenue by region</h1><p>Q2 2026 · USD thousands</p></figcaption>
  <svg viewBox="0 0 800 400" role="img" aria-label="Bar chart of revenue by region">…</svg>
</figure>
```

Make the SVG responsive with `viewBox` + `width:100%`; never hardcode pixel
widths on the outer element. Give it `role="img"` and an `aria-label`
summarizing the finding.

## Do / don't

- DO write the takeaway in the title. DO sort, label directly, start bars at 0.
- DON'T use pie charts for >3 categories, dual axes, 3-D, or truncated bar axes.
- DON'T rely on a live CDN — a chart that needs network is not self-contained.
