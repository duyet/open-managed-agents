# Kubernetes sandbox backends: `k8s-remote` vs `openshell`

OMA can run agent sandboxes on your own Kubernetes cluster two very different
ways. Both let a Cloudflare Worker (which can't load native drivers) drive
in-cluster sandboxes, and both are also reachable from the self-host Node
runtime — but they use different execution substrates, wire protocols, and
have different limitations. This page explains the difference and how to deploy
each.

## At a glance

| | **`k8s-remote`** | **`openshell`** |
|---|---|---|
| Execution model | Raw Kubernetes **pods** you own — one pod per session, created as a `Sandbox` CRD in a namespace | **NVIDIA OpenShell** managed sandboxes (isolated container/microVM) behind a single gateway control plane |
| What runs in-cluster | **k8s-sandbox-gateway** wrapping `KubernetesSandboxExecutor` | **k8s-bridge** with `BRIDGE_BACKEND=openshell` wrapping `OpenShellManager` |
| Worker ⇄ in-cluster protocol | boxrun-shaped **HTTP** (create / exec+SSE / files-as-tar / destroy) | boxrun-shaped **HTTP** (the bridge translates it to gRPC) |
| In-cluster ⇄ sandbox protocol | k8s `pods/exec` WebSocket subresource | **gRPC** `openshell.v1.OpenShell` to the OpenShell gateway |
| Provider id | `k8s-remote` (`K8S_SANDBOX_GATEWAY_URL`) | `openshell` (`OPENSHELL_BRIDGE_URL`) |
| Self-host Node path | direct `KubernetesSandboxExecutor` (in-cluster, kubeconfig) | direct gRPC to the gateway (`OPENSHELL_GATEWAY_ENDPOINT`) |
| Egress control | Kubernetes `NetworkPolicy` + the OMA outbound proxy | OpenShell **SandboxPolicy** (policy-enforced egress, mapped from the OMA environment config) |
| File I/O | tar archive over HTTP | base64-through-exec (no file RPC in the OpenShell API) |
| RBAC needed | **Yes** — the gateway needs pod create/exec/delete grants | **No** — the bridge owns no cluster; it only speaks gRPC out to the gateway |
| Memory-store / session-outputs mounts | Not exposed over the HTTP tar API | Not available (OpenShell manages its own workspace) |

## When to pick which

- **`k8s-remote`** — you want sandboxes to be **ordinary pods on your cluster**:
  your images, your `NetworkPolicy`, your node pools, your RBAC. The gateway is
  a thin shim over the same `KubernetesSandboxExecutor` the self-host runtime
  uses. Pick this when you already run Kubernetes and want full control over the
  pod spec.
- **`openshell`** — you want a **managed, policy-sandboxed runtime** with
  built-in egress enforcement and provider credential bundles, and you're
  running (or willing to run) an OpenShell gateway. OMA never touches the
  cluster the sandboxes live on; it just calls the gateway. Pick this when you
  want OpenShell's stronger isolation + egress policy without OMA holding
  cluster RBAC.

Both share the same limitation: memory-store and session-outputs bind-mounts
are not wired over these HTTP APIs (same as `boxrun`).

## Deploying the k8s-bridge with the OpenShell backend

The [`oma-k8s-bridge` Helm chart](../../charts/oma-k8s-bridge) now supports the
OpenShell backend. Point it at your gateway:

```bash
helm install oma-k8s-bridge charts/oma-k8s-bridge \
  --set secret.existingSecret=oma-k8s-bridge-token \
  --set config.backend=openshell \
  --set config.openshell.endpoint=openshell-gateway.openshell.svc:8080
```

This sets `BRIDGE_BACKEND=openshell` and `OPENSHELL_GATEWAY_ENDPOINT` on the
bridge. For TLS to the gateway, set `config.openshell.tls.enabled=true` and the
`caPath` / `certPath` / `keyPath` values (mount the material yourself). A
gateway bearer token goes in `secret.openshellToken` (or your `existingSecret`
as `OPENSHELL_TOKEN`). The bridge owns no cluster in this mode, so the chart's
RBAC grants are unused.

On the Cloudflare side, register the bridge URL as `OPENSHELL_BRIDGE_URL`
(`wrangler secret put`) and select `sandbox_provider: "openshell"` on the
environment. See [`AGENTS.md`](../../AGENTS.md) → sandbox provider table.

## Deploying the CLI bridge daemon on Kubernetes

`oma bridge daemon` can also run **in-cluster** as a reverse-WebSocket runtime
(the `subprocess` provider's relay), and it too can front an OpenShell gateway.
Manifests live in [`deploy/cli-bridge-daemon`](../../deploy/cli-bridge-daemon):

```bash
# 1. Pair a runtime + ship the creds into the cluster (see secret.example.yaml)
oma bridge setup --server-url https://<your-instance> --no-service
kubectl create secret generic oma-bridge-daemon-creds \
  --from-file=credentials.json="$HOME/.oma/bridge/credentials.json"

# 2. (optional) flip to the OpenShell backend
kubectl create configmap oma-bridge-daemon-config \
  --from-literal=OMA_BRIDGE_BACKEND=openshell \
  --from-literal=OMA_OPENSHELL_URL=openshell-gateway.openshell.svc:8080

# 3. Deploy
kubectl apply -f deploy/cli-bridge-daemon/
```

The daemon makes only **outbound** connections (WS to the control plane, gRPC
to the gateway) and never touches the Kubernetes API — so it needs **no
ServiceAccount or RBAC**.

### Backend selection

`oma bridge daemon` chooses its sandbox backend like the k8s-bridge does
(`resolveSandboxBackend`, `packages/cli/src/bridge/lib/sandbox-backend.ts`):

| Input | Effect |
|---|---|
| `--backend local` / `OMA_BRIDGE_BACKEND=local` | Local subprocess relay (default) |
| `--backend openshell` / `OMA_BRIDGE_BACKEND=openshell` | Relay each op to an OpenShell gateway over gRPC |
| `--openshell-url <host:port>` / `OMA_OPENSHELL_URL` | Gateway endpoint (auto-selects openshell when no backend is set) |
| `OMA_OPENSHELL_TOKEN`, `OMA_OPENSHELL_IMAGE` | Gateway token / sandbox image (fall back to the adapter's `OPENSHELL_*` names) |

> **Image note:** the default local relay runs with the published
> `@getoma/cli` on any Node image. The OpenShell backend dynamically imports
> `@duyet/oma-sandbox` (an internal, never-published workspace package), so it
> must run from an image with that package present — build
> [`Dockerfile.openshell`](../../deploy/cli-bridge-daemon/Dockerfile.openshell)
> from the repo root.
