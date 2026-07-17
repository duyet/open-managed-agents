---
name: spreadsheet-xlsx
description: Generate real Excel .xlsx workbooks from data. Trigger when the user asks to "export to Excel", "make a spreadsheet", "give me an xlsx", "download as Excel", or wants query/CSV/JSON results as a formatted workbook with headers, number formats, and multiple sheets. Uses openpyxl in the Python sandbox.
---

# spreadsheet-xlsx

Produce a genuine `.xlsx` (not a CSV renamed) with proper types, number
formats, a frozen/bold header row, and auto-sized columns. Use **openpyxl** —
it's pure Python, has no system dependencies, and installs in one step.

Reusable helpers are in [`snippets.py`](snippets.py) — copy them in rather than
rewriting boilerplate each time.

## Setup

```bash
uv pip install openpyxl          # pure-python, no apt packages needed
```

If the data is already in a pandas DataFrame, `df.to_excel(path, index=False,
engine="openpyxl")` is the fast path — but you still want the formatting pass
below, so openpyxl directly is usually clearer.

## Rules for a workbook that doesn't look amateur

1. **Write typed cells, not strings.** Put real numbers, dates, and booleans in
   cells so Excel can sum/sort them. Never write `"1,234"` or `"$1,234"` as
   text — write `1234` and set a number format.
2. **Number formats, not pre-formatted strings.** Currency `'"$"#,##0.00'`,
   thousands `'#,##0'`, percent `'0.0%'` (store `0.25`, not `25`), dates
   `'yyyy-mm-dd'`.
3. **Header row:** bold, frozen (`ws.freeze_panes = "A2"`), and turn on an
   autofilter over the data range.
4. **Column widths:** size to the longest value in each column (see snippet) —
   default widths clip everything.
5. **One sheet per logical table.** Name sheets meaningfully (`ws.title`), <= 31
   chars, no `[]/\*?:`. Add a small summary sheet first when there are many.
6. **Totals** go in a labeled row using real `=SUM(B2:B100)` formulas, not a
   hardcoded number, so they stay correct if the user edits cells.

## Minimal example

```python
from openpyxl import Workbook
from openpyxl.styles import Font
# from snippets.py:
from snippets import write_table, autosize, apply_number_format

wb = Workbook()
ws = wb.active
ws.title = "Revenue"
rows = [
    {"Region": "EMEA", "Revenue": 128400.0, "Growth": 0.12},
    {"Region": "APAC", "Revenue": 98200.0,  "Growth": -0.03},
]
write_table(ws, rows)                       # bold+frozen header, autofilter
apply_number_format(ws, "Revenue", '"$"#,##0')
apply_number_format(ws, "Growth", "0.0%")
autosize(ws)
wb.save("/workspace/revenue.xlsx")
```

## Verify before handing off

- Reopen it: `python -c "import openpyxl; wb=openpyxl.load_workbook('/workspace/revenue.xlsx'); ws=wb.active; print(ws.max_row, ws.max_column, ws['B2'].value, ws['B2'].number_format)"`
  — confirm the count, that numeric cells hold numbers (not strings), and the
  format stuck.
- Tell the user the path and sheet names. Don't paste the binary into chat.
