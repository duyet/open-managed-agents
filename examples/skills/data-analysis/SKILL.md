---
name: data-analysis
description: Explore, clean, and analyze a dataset to answer a real question, with honest handling of uncertainty and bias. Trigger when the user asks to "analyze this data", "what does this dataset show", "explore this CSV", works with pandas/numpy on tabular data, or wants a data-driven answer to a business/research question. Profile before cleaning, sanity-check before concluding, and always report the caveats alongside the finding.
---

# data-analysis

An analysis is only as good as the question it answers and the caveats it
discloses. A number without its uncertainty, sample size, or known bias is a
number that will be misused. Anchor every step in the actual question being
asked — don't just run statistics because the data supports them.

## 1. Start with the question, not the data

- Write down the specific question before opening the dataset: "did feature X
  change conversion?" is answerable; "tell me about this data" isn't — it
  invites cherry-picking whatever pattern looks interesting.
- Identify what decision this analysis feeds. That determines the bar for
  rigor — a rough sanity check for internal curiosity needs less than a
  number going into a public report.

## 2. Profile before you touch anything

Before cleaning or analyzing:

```python
df.shape                       # rows, columns
df.dtypes                      # are numbers actually numeric, dates actually dates?
df.isnull().sum()              # nulls per column
df.duplicated().sum()          # exact duplicate rows
df.describe(include="all")     # ranges, distinct counts, obvious outliers
df.sample(10)                  # eyeball real rows, don't trust the schema blindly
```

Know the data's shape and quality before drawing any conclusion from it —
most bad analyses trace back to an unnoticed null-heavy column or a units
mismatch (cents vs dollars, UTC vs local) caught too late.

## 3. Clean deliberately, and log every change

- Document every row/column you drop or value you impute, and why — a
  colleague (or future you) needs to know the cleaned data isn't the raw
  data.
- Don't silently drop nulls/outliers without checking whether they're
  meaningful (a null "cancellation_reason" might mean "not cancelled", not
  "missing data").
- Prefer flagging over deleting when unsure (`is_outlier` column) — deletion
  is a one-way door that hides the decision from later review.

## 4. Sanity-check before concluding

- **Check sample size** — a "40% lift" on 12 users isn't a finding, it's
  noise. Report the N alongside every rate/percentage.
- **Check for sampling bias** — does the data represent who/what you're
  claiming to generalize to, or just who was easiest to measure (e.g. only
  logged-in users, only completed transactions)?
- **Watch for Simpson's paradox** — a trend that holds in aggregate can
  reverse within every subgroup. Slice by the obvious confounders (cohort,
  region, time period) before trusting an aggregate number.
- **Correlation is not causation.** If the question is causal ("did X cause
  Y"), say explicitly whether the analysis can actually support that claim
  (controlled experiment) or only an association (observational data) —
  don't let the phrasing imply more certainty than the method supports.

## 5. Visualize honestly

- Choose the chart type for the comparison being made (see the `data-viz`
  skill for chart-type heuristics and palette guidance) — don't reach for a
  pie chart to show a trend or truncate a bar-chart y-axis to exaggerate a
  gap.
- Label axes, units, and sample size directly on the chart — a chart a reader
  has to caption-hunt to understand will be misread.

## 6. Report with uncertainty

State the finding, the sample size/confidence it rests on, and what would
change the conclusion (a caveat isn't hedging — it's the difference between a
result someone can act on and one that quietly misleads). Separate "what the
data shows" from "what I recommend doing about it" — the first is analysis,
the second is a judgment call the reader should be able to evaluate
independently.

## Don't

- Don't p-hack — running many slices until one crosses a significance
  threshold, then reporting only that one, is how false patterns get
  reported as real.
- Don't cherry-pick the time window or subgroup that best supports the
  desired conclusion — report the full picture, then explain.
- Don't present a point estimate from a small sample as if it were precise —
  round to a precision the sample size actually supports.
