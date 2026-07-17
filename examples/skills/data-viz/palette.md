# Accessible palettes

Copy these into the chart. They're chosen for colorblind safety and to hold up
in both light and dark themes. Do not generate ad-hoc per-series colors.

## Categorical (up to 8 series) — Okabe–Ito, colorblind-safe

| Order | Hex | Name |
|---|---|---|
| 1 | `#0072B2` | blue |
| 2 | `#E69F00` | orange |
| 3 | `#009E73` | green |
| 4 | `#CC79A7` | reddish purple |
| 5 | `#56B4E9` | sky blue |
| 6 | `#D55E00` | vermillion |
| 7 | `#F0E442` | yellow (use on dark fills only; low contrast on white) |
| 8 | `#000000` / `#FFFFFF` | fg (flip with theme) |

Assign in order; if you have >8 series, switch to small multiples instead of
recycling colors.

## Sequential (one variable, low → high)

Light→dark blue: `#deebf7 #9ecae1 #4292c6 #2171b5 #08519c`. Keep the darkest for
the highest value. Never use a rainbow ramp for sequential data.

## Diverging (around a midpoint, e.g. +/- change)

Blue↔red through neutral gray:
`#2166ac #67a9cf #d1e5f0 #f7f7f7 #fddbc7 #ef8a62 #b2182b`. Put the neutral color
at the true zero/midpoint, not at the data mean.

## Semantic accents (use sparingly, always with a label too)

- good / up: `#009E73`  ·  bad / down: `#D55E00`  ·  warning: `#E69F00`
- Never encode good/bad by red/green alone — add an arrow or text label.

## Contrast

- Data vs background: aim >= 3:1. Text labels vs background: >= 4.5:1.
- Gridlines: `#e5e5e5` (light theme) / `#333` (dark) — faint, behind the data.
