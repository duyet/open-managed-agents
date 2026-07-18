---
"@getoma/cli": patch
---

Add `oma bridge start`, `stop`, and `restart` to control the installed daemon
service without a full re-`setup`. They dispatch to the host's service manager
(launchd / systemd / Task Scheduler) and report daemon liveness afterward — the
missing "reconnect this machine" verbs the Console now points users to.
