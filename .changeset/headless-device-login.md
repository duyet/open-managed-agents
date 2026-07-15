---
"@duyet/oma-cli": patch
---

Add headless `oma auth login --device` (RFC 8628 device authorization: prints a URL + code, polls until approved) and `oma auth login --paste-token` (prints a URL, paste the token back) flows for non-interactive/CI environments.
