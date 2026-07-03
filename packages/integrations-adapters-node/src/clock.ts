// Trivial system clock — wraps Date.now(). Kept as a class so tests can swap
// with FakeClock without touching production call sites.

import type { Clock } from "@duyet/oma-integrations-core";

export class SystemClock implements Clock {
  nowMs(): number {
    return Date.now();
  }
}
