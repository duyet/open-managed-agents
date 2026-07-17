---
name: query-sql
description: Write, run, and iterate on SQL safely against a real database. Trigger when the user asks to "query the database", "write SQL", "pull this data", "join these tables", or points at a Postgres/MySQL/SQLite/DuckDB/Snowflake/BigQuery connection. Emphasizes schema discovery before writing, LIMIT while exploring, reading query plans, and dialect gotchas.
---

# query-sql

Never write SQL against a schema you haven't inspected. The failure mode is a
confidently-wrong query on guessed column names. Discover first, explore with
guardrails, then run the real thing.

## 1. Discover the schema first

List tables, then describe the ones you'll touch — check exact column names,
types, nullability, and keys before writing a `SELECT`.

```sql
-- Postgres
SELECT table_name FROM information_schema.tables WHERE table_schema='public';
SELECT column_name, data_type, is_nullable
FROM information_schema.columns WHERE table_name='orders' ORDER BY ordinal_position;
```

- SQLite: `.tables` and `PRAGMA table_info(orders);`
- MySQL: `SHOW TABLES;` / `DESCRIBE orders;`
- DuckDB: `SHOW TABLES;` / `DESCRIBE orders;` (or `PRAGMA table_info`)
- BigQuery: `SELECT * FROM dataset.INFORMATION_SCHEMA.COLUMNS WHERE table_name='orders'`

Look at a few real rows to learn the data's shape and value conventions:
`SELECT * FROM orders LIMIT 5;`.

## 2. Explore with guardrails

- **Always `LIMIT` while exploring.** Add `LIMIT 100` to every ad-hoc query so a
  fat-fingered join doesn't stream millions of rows. Remove it only for the
  final aggregate.
- Build joins incrementally: get one table right, add the next, verify row
  counts don't explode (a fan-out means a wrong/missing join key).
- `COUNT(*)` and `GROUP BY` to sanity-check cardinality before selecting detail.
- Prefer explicit column lists over `SELECT *` in anything you'll keep.

## 3. Read the plan before running heavy queries

Check the plan before running something that scans or aggregates a lot:

```sql
EXPLAIN ANALYZE SELECT ...   -- Postgres/MySQL8/DuckDB: shows real timing + rows
EXPLAIN SELECT ...           -- SQLite/BigQuery dry-run: estimate only
```

Watch for: `Seq Scan` / full-table scans on big tables (add or use an index /
filter), `Nested Loop` over large inputs, and estimated-vs-actual row blowups
(stale stats). Filter on indexed columns; wrapping a column in a function
(`WHERE date(ts)=…`) usually defeats its index — compare against a range
instead (`ts >= … AND ts < …`).

## 4. Safety

- **Read-only by default.** Don't run `UPDATE/DELETE/DROP/TRUNCATE` unless the
  user explicitly asked. If they did, `SELECT` the exact rows first, show the
  count, wrap in a transaction (`BEGIN; … ;`) and confirm before `COMMIT`.
- Never build SQL by string-concatenating user input — use parameterized
  queries / placeholders to avoid injection.
- A bare `DELETE`/`UPDATE` with no `WHERE` is almost always a mistake.

## 5. Dialect gotchas

- **Identifier quoting:** Postgres/standard use `"double quotes"`; MySQL uses
  `` `backticks` ``. `'single quotes'` are string literals everywhere — quoting
  a column with them silently gives you a constant string.
- **String concat:** `||` (Postgres/SQLite/DuckDB/Oracle) vs `CONCAT()` (MySQL —
  `||` means OR there unless `PIPES_AS_CONCAT` is set).
- **LIMIT:** `LIMIT n` (Postgres/MySQL/SQLite/DuckDB) vs `TOP n` (SQL Server) vs
  `FETCH FIRST n ROWS ONLY` (standard/Oracle).
- **Case & NULLs:** `NULL = NULL` is never true — use `IS NULL` / `IS DISTINCT
  FROM`. `COUNT(col)` skips NULLs; `COUNT(*)` doesn't.
- **Integer division:** `5/2` = `2` in Postgres/SQL Server with integer operands
  — cast (`5::numeric/2`) for a real quotient.
- **Dates:** `CURRENT_DATE`, `NOW()`, interval syntax, and `date_trunc`
  vs `DATE_FORMAT`/`EXTRACT` all differ. Confirm the engine before writing date
  math.
- **Group by:** standard SQL requires every non-aggregated select column in
  `GROUP BY` (Postgres is strict; MySQL historically wasn't).

## Deliver

Return the final query, a one-line description of what it returns, and the
result (or a small sample + row count). If it's a query the user will re-run,
give them the clean, `LIMIT`-free, explicit-column version.
