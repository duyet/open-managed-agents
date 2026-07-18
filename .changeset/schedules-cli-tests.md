---
"@getoma/cli": patch
---

Add command-level tests for the `oma schedules` verbs; export the internal command registry so handlers are unit-testable with a stubbed fetch (no behavior change).
