---
"@getoma/cli": patch
---

`oma bridge daemon` can now relay sandbox ops to an NVIDIA OpenShell gateway over gRPC via `--backend openshell --openshell-url <host:port>` (or `OMA_BRIDGE_BACKEND=openshell` + `OMA_OPENSHELL_URL`), reusing the `@duyet/oma-sandbox` adapter; default stays the local subprocess relay.
