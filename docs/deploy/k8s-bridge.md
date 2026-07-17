# K8s Bridge — Deployment & Install Guide

> **In a hurry?** See the [10-minute quickstart](./k8s-bridge-quickstart.md)
> for the condensed install → register → verify path.

## Overview

The **k8s-bridge** is an HTTP bridge that lets Cloudflare Workers manage
sandbox pods on a Kubernetes cluster via a minimal REST API. Because
Cloudflare Workers run in a V8 isolate and cannot load
`@kubernetes/client-node` or any other native/Node-gyp library, they
cannot call the Kubernetes API directly. k8s-bridge solves this by
exposing a small, credential-gated HTTP API that maps to Kubernetes
API operations.

```
Cloudflare Worker → k8s-bridge (HTTPS + Bearer) → Kubernetes API → Pod
```

The bridge itself ships as a container image and runs as a Deployment
inside your cluster. The OMA sandbox adapter
(`packages/sandbox/src/adapters/k8s-bridge.ts`) uses `globalThis.fetch`
— zero driver deps — making it the only sandbox provider that works in
a Cloudflare Worker while managing real Kubernetes pods.

---

## Prerequisites

| Requirement | Version / Notes |
|---|---|
| Kubernetes cluster | v1.25+ (tested on 1.28–1.31) |
| Helm 3 | `helm version` must show v3.x |
| `kubectl` | Configured with cluster-admin or equivalent |
| DNS domain | Points to your ingress controller (e.g. `k8s-bridge.example.com`) |
| cert-manager | Installed in cluster for automatic TLS |
| Metrics Server | Optional — required for `/api/v1/sandboxes/metrics` |
| OMA deployment | Cloudflare Workers or self-host Node instance |

---

## Quick Start

```bash
# 1. Add the Helm repository
helm repo add oma https://charts.oma.duyet.net
helm repo update

# 2. Generate a strong random token for API authentication
export K8S_BRIDGE_TOKEN=$(openssl rand -base64 32)
echo "Save this token — you will need it in the OMA sandbox config:"
echo "$K8S_BRIDGE_TOKEN"

# 3. Install the chart
helm install oma-k8s-bridge oma/oma-k8s-bridge \
  --namespace oma-sandbox \
  --create-namespace \
  --set secret.token=$K8S_BRIDGE_TOKEN \
  --set ingress.enabled=true \
  --set ingress.host=k8s-bridge.example.com

# 4. Wait for the deployment to roll out
kubectl -n oma-sandbox rollout status deployment/oma-k8s-bridge

# 5. Verify the bridge is healthy
curl -H "Authorization: Bearer $K8S_BRIDGE_TOKEN" \
  https://k8s-bridge.example.com/api/v1/health

# Expected response:
# {"status":"ok","kubernetes":"v1.30.2","namespace":"oma-sandbox"}
```

---

## Helm Configuration

All values in `values.yaml`:

| Parameter | Type | Default | Description |
|---|---|---|---|
| `replicaCount` | int | `2` | Number of bridge replicas |
| `image.repository` | string | `ghcr.io/duyet/oma/k8s-bridge` | Container image |
| `image.tag` | string | `latest` | Image tag |
| `image.pullPolicy` | string | `IfNotPresent` | Image pull policy |
| `secret.token` | string | `""` | Bearer token for API auth (REQUIRED) |
| `secret.existingSecret` | string | `""` | Name of existing Secret (alternative to `token`) |
| `secret.tokenKey` | string | `"token"` | Key inside existing secret that holds the token |
| `service.type` | string | `ClusterIP` | Service type |
| `service.port` | int | `8080` | Service port |
| `ingress.enabled` | bool | `false` | Enable ingress |
| `ingress.host` | string | `""` | Ingress hostname (required when enabled) |
| `ingress.className` | string | `""` | Ingress class name (leave empty to use cluster default) |
| `ingress.annotations` | object | `{}` | Additional ingress annotations |
| `ingress.tls` | bool | `true` | Enable TLS via cert-manager ClusterIssuer |
| `ingress.clusterIssuer` | string | `letsencrypt-prod` | cert-manager ClusterIssuer name |
| `resources.requests.cpu` | string | `"100m"` | CPU request |
| `resources.requests.memory` | string | `"128Mi"` | Memory request |
| `resources.limits.cpu` | string | `"500m"` | CPU limit |
| `resources.limits.memory` | string | `"512Mi"` | Memory limit |
| `autoscaling.enabled` | bool | `false` | Enable HPA |
| `autoscaling.minReplicas` | int | `2` | Minimum replicas |
| `autoscaling.maxReplicas` | int | `10` | Maximum replicas |
| `autoscaling.targetCPUUtilization` | int | `70` | Target CPU utilization percentage |
| `autoscaling.targetMemoryUtilization` | int | `80` | Target memory utilization percentage |
| `rbac.create` | bool | `true` | Create ClusterRole + ClusterRoleBinding |
| `rbac.namespaced` | bool | `true` | Restrict RBAC to a single namespace |
| `rbac.targetNamespace` | string | `oma-sandbox` | Namespace for sandbox pods |
| `nodeSelector` | object | `{}` | Node selector constraints |
| `tolerations` | list | `[]` | Pod tolerations |
| `affinity` | object | `{}` | Pod affinity rules |
| `podAnnotations` | object | `{}` | Additional pod annotations |
| `podLabels` | object | `{}` | Additional pod labels |
| `extraEnv` | list | `[]` | Extra environment variables |
| `networkPolicy.enabled` | bool | `true` | Create NetworkPolicy |
| `networkPolicy.egressCIDRs` | list | `["0.0.0.0/0"]` | Allowed egress CIDRs |
| `securityContext.readOnlyRootFilesystem` | bool | `true` | Immutable rootfs |
| `securityContext.runAsNonRoot` | bool | `true` | Non-root user |
| `securityContext.runAsUser` | int | `65534` | nobody UID |
| `securityContext.capabilities.drop` | list | `["ALL"]` | Drop all kernel capabilities |
| `serviceAccount.create` | bool | `true` | Create service account |
| `serviceAccount.name` | string | `""` | Service account name (default: release name) |
| `podDisruptionBudget.enabled` | bool | `true` | Enable PDB |
| `podDisruptionBudget.minAvailable` | int | `1` | Minimum available pods |
| `livenessProbe` | object | `{...}` | Liveness probe config |
| `readinessProbe` | object | `{...}` | Readiness probe config |
| `logLevel` | string | `"info"` | Log level (debug, info, warn, error) |
| `box.defaultImage` | string | `"ghcr.io/duyet/oma-runtime-base:latest"` | Default sandbox container image |
| `box.defaultCpu` | string | `"1"` | Default CPU for sandbox pods |
| `box.defaultMemory` | string | `"512Mi"` | Default memory for sandbox pods |
| `box.defaultTtlSeconds` | int | `3600` | Default TTL for sandbox pods (seconds) |
| `box.maxCpu` | string | `"4"` | Maximum allowed CPU per box |
| `box.maxMemory` | string | `"4Gi"` | Maximum allowed memory per box |
| `box.maxBoxesPerSession` | int | `3` | Max boxes per session id |
| `box.maxConcurrentBoxes` | int | `50` | Global max concurrent boxes |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Cloudflare Worker                         │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  K8sBridgeSandbox (packages/sandbox/src/adapters/)        │  │
│  │  • globalThis.fetch — no driver deps                      │  │
│  │  • K8S_BRIDGE_URL env → baseUrl                           │  │
│  │  • K8S_BRIDGE_TOKEN env → Bearer auth                     │  │
│  │  • Lazy box creation (ensureBox on first use)              │  │
│  └────────────────────┬──────────────────────────────────────┘  │
└───────────────────────┼──────────────────────────────────────────┘
                        │  HTTPS + Authorization: Bearer <token>
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│  Kubernetes Cluster                                             │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  k8s-bridge Pod (Deployment)                              │  │
│  │  • HTTP server :8080                                      │  │
│  │  • Validates Bearer token                                  │  │
│  │  • Translates REST → Kubernetes API calls                  │  │
│  │  • Manages sandbox Pod lifecycle                           │  │
│  │  • Streams exec/fetch responses                            │  │
│  └────────────────────┬──────────────────────────────────────┘  │
│                       │  In-cluster K8s API (ServiceAccount)     │
│                       ▼                                          │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Sandbox Pod (Ephemeral)                                  │  │
│  │  • Runs container image (default: node:22-slim)            │  │
│  │  • /workspace for agent file operations                    │  │
│  │  • TTL-based cleanup (default: 1 hour)                     │  │
│  │  • Dedicated ServiceAccount per namespace                  │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  cert-manager → Ingress → TLS termination                  │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

**Request flow for a typical sandbox operation:**

```
1. Agent tool calls exec("npm test")
2. K8sBridgeSandbox.ensureBox() → POST /api/v1/boxes  (lazy, first call only)
3. K8sBridgeSandbox.exec()      → POST /api/v1/boxes/<id>/exec
4. k8s-bridge receives request, validates token
5. k8s-bridge creates Pod (if not exists) or exec into existing Pod
6. Streams stdout/stderr back to the Worker
7. Sandbox.destroy()            → DELETE /api/v1/boxes/<id>
```

---

## API Endpoints

All endpoints require the `Authorization: Bearer <token>` header (value of
`K8S_BRIDGE_TOKEN`). Responses are JSON unless noted.

### GET /api/v1/health

Health check. Returns bridge and Kubernetes version info.

```bash
curl -H "Authorization: Bearer $K8S_BRIDGE_TOKEN" \
  https://k8s-bridge.example.com/api/v1/health
```

```json
{
  "status": "ok",
  "version": "1.0.0",
  "kubernetes": "v1.30.2",
  "namespace": "oma-sandbox",
  "uptime_seconds": 84320,
  "active_boxes": 3,
  "total_boxes_created": 157
}
```

### GET /api/v1/cluster/info

Returns cluster metadata.

```bash
curl -H "Authorization: Bearer $K8S_BRIDGE_TOKEN" \
  https://k8s-bridge.example.com/api/v1/cluster/info
```

```json
{
  "version": "v1.30.2",
  "platform": "linux/amd64",
  "nodes": 5,
  "capacity": {
    "cpu": "16",
    "memory": "65536Ki",
    "pods": "110"
  },
  "allocatable": {
    "cpu": "14",
    "memory": "62000Ki",
    "pods": "105"
  }
}
```

### GET /api/v1/cluster/nodes

List cluster nodes with status, roles, and version.

```bash
curl -H "Authorization: Bearer $K8S_BRIDGE_TOKEN" \
  https://k8s-bridge.example.com/api/v1/cluster/nodes
```

```json
{
  "nodes": [
    {
      "name": "pool-1-abcde",
      "status": "Ready",
      "roles": ["control-plane", "worker"],
      "version": "v1.30.2",
      "cpu": {"capacity": "4", "allocatable": "3.5"},
      "memory": {"capacity": "16384Mi", "allocatable": "15500Mi"},
      "pods": {"capacity": "110", "allocatable": "105", "running": 12}
    }
  ]
}
```

### GET /api/v1/cluster/capacity

Aggregate cluster capacity — used to feed the console runtime gauges and the
`estimatedAdditionalSandboxes` headroom figure. Default per-sandbox request
size comes from `OMA_K8S_CPU` (default `500m`) and `OMA_K8S_MEMORY` (default
`512Mi`).

```bash
curl -H "Authorization: Bearer $K8S_BRIDGE_TOKEN" \
  https://k8s-bridge.example.com/api/v1/cluster/capacity
```

```json
{
  "totalCpu": "4",
  "totalMemory": "16384Mi",
  "allocatableCpu": "3.5",
  "allocatableMemory": "15500Mi",
  "requestedCpu": "2",
  "requestedMemory": "6144Mi",
  "runningPods": 12,
  "maxPods": 105,
  "estimatedAdditionalSandboxes": 3
}
```

`estimatedAdditionalSandboxes = max(0, min(remainingCpu/defaultCpu,
remainingMem/defaultMem, remainingPodSlots))`.

### GET /api/v1/sandboxes

List all sandbox pods in the target namespace.

```bash
curl -H "Authorization: Bearer $K8S_BRIDGE_TOKEN" \
  https://k8s-bridge.example.com/api/v1/sandboxes
```

```json
{
  "sandboxes": [
    {
      "name": "box-abc123",
      "namespace": "oma-sandbox",
      "status": "Running",
      "node": "pool-1-abcde",
      "image": "node:22-slim",
      "created_at": "2026-07-15T10:00:00Z",
      "age_seconds": 3420,
      "session_id": "sess_xyz",
      "cpu": "1",
      "memory": "512Mi"
    }
  ],
  "total": 1,
  "namespace": "oma-sandbox"
}
```

### GET /api/v1/sandboxes/:podName/logs

Fetch logs from a sandbox pod. Supports optional `?tailLines=` parameter.

```bash
# Last 100 lines
curl -H "Authorization: Bearer $K8S_BRIDGE_TOKEN" \
  https://k8s-bridge.example.com/api/v1/sandboxes/box-abc123/logs?tailLines=100

# All logs (no tailLines)
curl -H "Authorization: Bearer $K8S_BRIDGE_TOKEN" \
  https://k8s-bridge.example.com/api/v1/sandboxes/box-abc123/logs
```

```text
> npm test
PASS  tests/index.test.ts
  ✓ should return hello (2ms)

Test Suites: 1 passed, 1 total
Tests:       1 passed, 1 total
```

### GET /api/v1/sandboxes/metrics

Pod resource metrics. Requires `metrics-server` in the cluster.

```bash
curl -H "Authorization: Bearer $K8S_BRIDGE_TOKEN" \
  https://k8s-bridge.example.com/api/v1/sandboxes/metrics
```

```json
{
  "metrics": [
    {
      "pod_name": "box-abc123",
      "namespace": "oma-sandbox",
      "cpu": "12m",
      "memory": "45Mi",
      "timestamp": "2026-07-15T12:00:00Z",
      "window_seconds": 60
    }
  ]
}
```

### GET /api/v1/sandboxes/:id

Full detail for a single sandbox — pod status, per-container states, resource
requests, and live metrics (when `metrics-server` is present). Returns 404
`{"error":"not_found"}` if no matching pod exists.

```bash
curl -H "Authorization: Bearer $K8S_BRIDGE_TOKEN" \
  https://k8s-bridge.example.com/api/v1/sandboxes/box-abc123
```

```json
{
  "id": "box-abc123",
  "boxId": "box-abc123",
  "sessionId": "sess_xyz",
  "namespace": "oma-sandbox",
  "podName": "box-abc123",
  "nodeName": "pool-1-abcde",
  "status": "Running",
  "phase": "Running",
  "containerStatuses": [
    { "name": "sandbox", "ready": true, "restartCount": 0, "state": "running" }
  ],
  "cpuRequest": "1",
  "memoryRequest": "512Mi",
  "createdAt": "2026-07-15T10:00:00Z",
  "durationSeconds": 3420,
  "labels": { "oma.sh/session": "sess_xyz" },
  "metrics": {
    "podName": "box-abc123",
    "namespace": "oma-sandbox",
    "cpuUsage": "12m",
    "memoryUsage": "45Mi",
    "timestamp": "2026-07-15T12:00:00Z",
    "containers": [{ "name": "sandbox", "cpuUsage": "12m", "memoryUsage": "45Mi" }]
  }
}
```

### Slack sandbox-event notifications

Set `SLACK_WEBHOOK_URL` to enable a background poller (`SandboxMonitor`, every
15s by default) that posts to Slack when a sandbox misbehaves:

| Event | Fires when |
|---|---|
| `sandbox_oom` | container terminated / last-terminated reason is `OOMKilled` |
| `sandbox_crashed` | container waiting reason is `CrashLoopBackOff` |
| `sandbox_pending` | pod stuck `Pending` past ~30s |
| `cluster_low_capacity` | CPU or memory used ≥ 90% |

Per-session events (`sandbox_oom` / `sandbox_crashed` / `sandbox_pending`) are
debounced (default 30s per `event:sessionId`) so a flapping pod doesn't spam
the channel. Narrow the set with `SLACK_NOTIFY_ON` (comma-separated allowlist;
default is all event types). The notifier is fail-open — a Slack outage never
affects sandbox operation. No `SLACK_WEBHOOK_URL` means no poller and no
notifications.

### POST /api/v1/boxes

Create a sandbox box (ephemeral pod).

```bash
curl -X POST -H "Authorization: Bearer $K8S_BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "sess_xyz",
    "image": "node:22-slim",
    "cpu": 1,
    "memory": 512,
    "env": {
      "NODE_ENV": "development",
      "DEBUG": "true"
    }
  }' \
  https://k8s-bridge.example.com/api/v1/boxes
```

```json
{
  "box_id": "box-abc123",
  "status": "Pending",
  "namespace": "oma-sandbox",
  "pod_name": "box-abc123",
  "image": "node:22-slim",
  "cpu": "1",
  "memory": "512Mi",
  "created_at": "2026-07-15T10:00:00Z"
}
```

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `sessionId` | string | Yes | — | OMA session identifier |
| `image` | string | No | `ghcr.io/duyet/oma-runtime-base:latest` | Container image for the sandbox |
| `cpu` | number | No | `1` | CPU cores (fractional OK) |
| `memory` | number | No | `512` | Memory in MiB |
| `env` | object | No | `{}` | Environment variables |
| `runtimeClassName` | string | No | — | Kubernetes RuntimeClass (e.g. `kata`) |
| `serviceAccountName` | string | No | — | Custom ServiceAccount for the pod |

### DELETE /api/v1/boxes/:id

Destroy a sandbox box.

```bash
curl -X DELETE -H "Authorization: Bearer $K8S_BRIDGE_TOKEN" \
  https://k8s-bridge.example.com/api/v1/boxes/box-abc123
```

```json
{
  "box_id": "box-abc123",
  "status": "Terminated",
  "deleted_at": "2026-07-15T12:00:00Z"
}
```

Returns `404` if the box does not exist (idempotent cleanup).

### POST /api/v1/boxes/:id/exec

Execute a command inside a running sandbox box.

```bash
curl -X POST -H "Authorization: Bearer $K8S_BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "command": "npm test",
    "timeoutMs": 30000,
    "workdir": "/workspace"
  }' \
  https://k8s-bridge.example.com/api/v1/boxes/box-abc123/exec
```

```json
{
  "exit_code": 0,
  "stdout": "PASS  tests/index.test.ts\n  ✓ should return hello (2ms)\n\nTest Suites: 1 passed, 1 total\nTests:       1 passed, 1 total\n",
  "stderr": "",
  "duration_ms": 2843
}
```

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `command` | string | Yes | — | Shell command to execute |
| `timeoutMs` | number | No | `120000` | Execution timeout in milliseconds |
| `workdir` | string | No | `/workspace` | Working directory |

### GET /api/v1/boxes/:id/files

Read a file from the sandbox box.

```bash
curl -H "Authorization: Bearer $K8S_BRIDGE_TOKEN" \
  "https://k8s-bridge.example.com/api/v1/boxes/box-abc123/files?path=/workspace/output.json"
```

```json
{
  "path": "/workspace/output.json",
  "size": 1234,
  "content": "{\"result\": \"ok\", \"data\": [...]}",
  "encoding": "text"
}
```

For binary files, append `?path=...&base64=true`:

```json
{
  "path": "/workspace/screenshot.png",
  "size": 45678,
  "content": "iVBORw0KGgo... (base64-encoded)",
  "encoding": "base64"
}
```

### PUT /api/v1/boxes/:id/files

Write a file to the sandbox box.

```bash
# Write text content
curl -X PUT -H "Authorization: Bearer $K8S_BRIDGE_TOKEN" \
  -H "Content-Type: text/plain" \
  -d 'console.log("hello world");' \
  "https://k8s-bridge.example.com/api/v1/boxes/box-abc123/files?path=/workspace/index.js"

# Write binary content (base64-encoded)
curl -X PUT -H "Authorization: Bearer $K8S_BRIDGE_TOKEN" \
  -H "Content-Type: text/plain" \
  -d 'iVBORw0KGgo...' \
  "https://k8s-bridge.example.com/api/v1/boxes/box-abc123/files?path=/workspace/image.png&base64=true"
```

```json
{
  "path": "/workspace/index.js",
  "size": 26,
  "encoding": "text"
}
```

### POST /api/v1/boxes/:id/env

Set environment variables on a running box. Does not restart the pod —
variables are injected into subsequent exec calls.

```bash
curl -X POST -H "Authorization: Bearer $K8S_BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "envVars": {
      "ANTHROPIC_API_KEY": "sk-ant-...",
      "NODE_OPTIONS": "--max-old-space-size=4096"
    }
  }' \
  https://k8s-bridge.example.com/api/v1/boxes/box-abc123/env
```

```json
{
  "box_id": "box-abc123",
  "env_count": 2,
  "updated_at": "2026-07-15T12:05:00Z"
}
```

### GET /api/v1/boxes/:id/status

Get the current status of a sandbox box.

```bash
curl -H "Authorization: Bearer $K8S_BRIDGE_TOKEN" \
  https://k8s-bridge.example.com/api/v1/boxes/box-abc123/status
```

```json
{
  "box_id": "box-abc123",
  "pod_name": "box-abc123",
  "namespace": "oma-sandbox",
  "status": "Running",
  "phase": "Running",
  "node": "pool-1-abcde",
  "image": "node:22-slim",
  "cpu": "1",
  "memory": "512Mi",
  "created_at": "2026-07-15T10:00:00Z",
  "age_seconds": 7500,
  "restarts": 0,
  "host_ip": "10.0.0.5",
  "pod_ip": "10.42.0.12",
  "conditions": [
    {"type": "Initialized", "status": "True"},
    {"type": "Ready", "status": "True"},
    {"type": "ContainersReady", "status": "True"},
    {"type": "PodScheduled", "status": "True"}
  ]
}
```

---

## RBAC Permissions

The chart creates a `ClusterRole` with the following rules (scoped to
a single namespace when `rbac.namespaced=true`):

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: oma-k8s-bridge
rules:
  # Cluster capacity reporting — get node count, allocatable resources,
  # and pod density for the /api/v1/cluster/info and /api/v1/cluster/nodes endpoints.
  - apiGroups: [""]
    resources: ["nodes"]
    verbs: ["list", "get"]

  # Sandbox lifecycle management — create, list, watch, and delete
  # ephemeral pods in the sandbox namespace.
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["create", "get", "list", "watch", "delete", "patch"]

  # Pod log streaming — required for /api/v1/sandboxes/:podName/logs.
  - apiGroups: [""]
    resources: ["pods/log"]
    verbs: ["get"]

  # Pod status patching — required for status reporting on boxes and
  # condition tracking in /api/v1/boxes/:id/status.
  - apiGroups: [""]
    resources: ["pods/status"]
    verbs: ["patch"]

  # Resource usage metrics — required for /api/v1/sandboxes/metrics.
  # Only needed if the metrics-server is installed and you use that endpoint.
  - apiGroups: ["metrics.k8s.io"]
    resources: ["pods"]
    verbs: ["get", "list"]

  # Exec into running pods — required for /api/v1/boxes/:id/exec.
  - apiGroups: [""]
    resources: ["pods/exec"]
    verbs: ["create"]
```

**Why each permission is needed:**

| Permission | Used By | Purpose |
|---|---|---|
| `nodes list/get` | `/api/v1/cluster/info`, `/api/v1/cluster/nodes` | Capacity reporting, scheduling decisions |
| `pods create/get/list/watch/delete/patch` | All box endpoints | Full sandbox pod lifecycle |
| `pods/log get` | `/api/v1/sandboxes/:podName/logs` | Fetch build/test output for the agent |
| `pods/status patch` | `/api/v1/boxes/:id/status` | Track pod conditions and phase |
| `pods/exec create` | `/api/v1/boxes/:id/exec` | Run commands inside the sandbox |
| `metrics.k8s.io pods get/list` | `/api/v1/sandboxes/metrics` | Resource usage monitoring |

When `rbac.namespaced=true` (default), the `ClusterRole` is paired with
a `RoleBinding` (not `ClusterRoleBinding`) that scopes all pod operations
to `rbac.targetNamespace` (default: `oma-sandbox`). Node and metrics
permissions still require `ClusterRole` since those resources are
cluster-scoped, but the binding limits which namespace the bridge can
create pods in.

---

## Security

### Token Authentication

Every request must include `Authorization: Bearer <token>`. The token is
generated at install time and stored in a Kubernetes Secret:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: oma-k8s-bridge-token
  namespace: oma-sandbox
type: Opaque
data:
  token: <base64-encoded>
```

Rotate the token at any time without redeploying:

```bash
# Generate new token
NEW_TOKEN=$(openssl rand -base64 32)

# Update the secret
kubectl -n oma-sandbox patch secret oma-k8s-bridge-token \
  -p "{\"data\":{\"token\":\"$(echo -n "$NEW_TOKEN" | base64 -w0)\"}}"

# Restart the deployment to pick up the new token
kubectl -n oma-sandbox rollout restart deployment/oma-k8s-bridge

# Update OMA environment variable
# (set K8S_BRIDGE_TOKEN=$NEW_TOKEN in your OMA config)
```

### TLS

The chart uses cert-manager to provision and renew TLS certificates
automatically:

```yaml
ingress:
  enabled: true
  host: oma-k8s-bridge.example.com
  tls: true
  clusterIssuer: letsencrypt-prod
```

This produces an `Ingress` + `Certificate` pair. The certificate is
stored in a Secret named `oma-k8s-bridge-tls` and mounted automatically.

### Pod Security

The bridge runs with a hardened security context:

```yaml
securityContext:
  readOnlyRootFilesystem: true    # immutable rootfs — no writes to /bin, /etc, /usr
  runAsNonRoot: true              # reject if runAsUser is 0
  runAsUser: 65534                # nobody
  capabilities:
    drop: ["ALL"]                 # no kernel capabilities
```

Sandbox pods (boxes) also run with restricted defaults, enforced via
a `PodSecurityAdmission` label on the `oma-sandbox` namespace:

```bash
kubectl label ns oma-sandbox pod-security.kubernetes.io/enforce=restricted
```

### Network Policy

The chart creates a default-deny NetworkPolicy when `networkPolicy.enabled=true`:

```yaml
# Only allow ingress from the cluster (for kubelet health probes)
# and egress to the outside world (for the agent to fetch dependencies).
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: oma-k8s-bridge
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: oma-k8s-bridge
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - podSelector: {}          # same-namespace pods
        - namespaceSelector: {}    # kubelet health probes
      ports:
        - port: 8080
  egress:
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0       # override with networkPolicy.egressCIDRs
```

### Rate Limiting

The bridge enforces per-client rate limits at the application layer:

| Limit | Value |
|---|---|
| Requests per second | 100 |
| Burst | 200 |
| Concurrent execs per box | 5 |
| Max exec duration | 10 minutes |

---

## Production

### Horizontal Pod Autoscaling

```bash
helm upgrade oma-k8s-bridge oma/oma-k8s-bridge \
  --set autoscaling.enabled=true \
  --set autoscaling.minReplicas=2 \
  --set autoscaling.maxReplicas=10 \
  --set autoscaling.targetCPUUtilization=70 \
  --set autoscaling.targetMemoryUtilization=80
```

### Resource Limits for Sandbox Boxes

Control sandbox resource consumption at the bridge level:

```bash
helm upgrade oma-k8s-bridge oma/oma-k8s-bridge \
  --set box.defaultCpu=1 \
  --set box.defaultMemory=512Mi \
  --set box.maxCpu=4 \
  --set box.maxMemory=4Gi \
  --set box.maxConcurrentBoxes=50 \
  --set box.defaultTtlSeconds=3600
```

The bridge enforces `maxCpu` and `maxMemory` server-side — requests
exceeding these limits receive a `400 Bad Request` response.

### Monitoring

The `/api/v1/health` endpoint returns operational metrics for external
monitoring:

```bash
# Prometheus blackbox probe
curl -H "Authorization: Bearer $K8S_BRIDGE_TOKEN" \
  https://k8s-bridge.example.com/api/v1/health
```

Key metrics to alert on:

| Metric | Threshold | Action |
|---|---|---|
| `active_boxes` | > 80% of `maxConcurrentBoxes` | Scale up or investigate leak |
| Uptime | < 60s after restart | Investigate crash loop |
| Health status | not `"ok"` | Page operator |

For Prometheus-native monitoring, deploy the chart with `podAnnotations`
to enable metric scraping:

```bash
helm upgrade oma-k8s-bridge oma/oma-k8s-bridge \
  --set podAnnotations."prometheus\.io/scrape"=true \
  --set podAnnotations."prometheus\.io/port"=8080 \
  --set podAnnotations."prometheus\.io/path"=/metrics
```

### Namespace Isolation

Each OMA deployment (staging, production, team-specific) should use a
dedicated namespace:

```bash
helm install oma-k8s-bridge oma/oma-k8s-bridge \
  --namespace oma-sandbox-prod \
  --create-namespace \
  --set rbac.targetNamespace=oma-sandbox-prod \
  --set secret.token=$K8S_BRIDGE_TOKEN_PROD \
  ...
```

This ensures:
- Pods from one deployment cannot see pods from another
- Resource quotas per namespace
- Independent NetworkPolicy boundaries
- Clean RBAC scoping

### Upgrading

```bash
helm repo update
helm upgrade oma-k8s-bridge oma/oma-k8s-bridge \
  --namespace oma-sandbox \
  --reuse-values
```

Review changes before applying:

```bash
helm diff upgrade oma-k8s-bridge oma/oma-k8s-bridge --namespace oma-sandbox
```

---

## Integration with OMA

### Self-host Node

Set environment variables on the `oma-server` process:

```bash
# .env or docker-compose environment
SANDBOX_PROVIDER=k8s-bridge
K8S_BRIDGE_URL=http://k8s-bridge:8080
K8S_BRIDGE_TOKEN=<the-token-you-generated>
SANDBOX_IMAGE=node:22-slim
K8S_CPU=1
K8S_MEMORY=512
```

The `sandboxFactory` in `packages/sandbox/src/adapters/k8s-bridge.ts`
reads these env vars at boot and constructs a `K8sBridgeSandbox` instance
for each session.

### Cloudflare Workers

Add the environment bindings to your `wrangler.jsonc`:

```json
{
  "name": "managed-agents-agent",
  "vars": {
    "SANDBOX_PROVIDER": "k8s-bridge",
    "K8S_BRIDGE_URL": "https://k8s-bridge.example.com",
    "K8S_BRIDGE_TOKEN": "",
    "SANDBOX_IMAGE": "node:22-slim",
    "K8S_CPU": "1",
    "K8S_MEMORY": "512"
  }
}
```

The `K8S_BRIDGE_TOKEN` should be set as a secret, not a plain var:

```bash
echo "$K8S_BRIDGE_TOKEN" | npx wrangler secret put K8S_BRIDGE_TOKEN
```

### Per-Environment Agent Config

In the OMA agent config, reference the k8s-bridge sandbox provider:

```json
{
  "name": "k8s-coder",
  "model": "claude-sonnet-4-6",
  "system": "You are a coding assistant running on Kubernetes.",
  "tools": [{ "type": "agent_toolset_20260401" }],
  "environment_id": "env_k8s"
}
```

Where the environment `env_k8s` has:

```json
{
  "name": "k8s-sandbox",
  "config": {
    "sandbox_provider": "k8s-bridge",
    "image": "node:22-slim"
  }
}
```

### Provider Registration (Self-host Node)

On the self-host Node runtime, k8s-bridge is registered through the
`SandboxProviderRegistry` in `packages/sandbox`. It is available alongside
all other providers. No additional registration step is needed — set
`SANDBOX_PROVIDER=k8s-bridge` and the factory resolves it.

### Provider Registration (Cloudflare Workers)

On the Cloudflare runtime, k8s-bridge is wired at build time through the
agent worker's `resolveCfSandbox` function. Ensure the following are true:

1. The agent worker has `K8S_BRIDGE_URL` as a binding (env var or secret)
2. `SANDBOX_PROVIDER=k8s-bridge` or the environment's
   `config.sandbox_provider` is set to `"k8s-bridge"`
3. `K8S_BRIDGE_TOKEN` is set as a `wrangler secret`

### Verify the Integration

```bash
# 1. Create an agent on the k8s-bridge environment
AGENT_ID=$(curl -s -X POST $OMA_BASE/v1/agents \
  -H "x-api-key: $OMA_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "name": "k8s-test",
    "model": "claude-sonnet-4-6",
    "system": "You are a helpful assistant.",
    "tools": [{"type": "agent_toolset_20260401"}]
  }' | jq -r .id)

# 2. Create a session
SESSION_ID=$(curl -s -X POST $OMA_BASE/v1/sessions \
  -H "x-api-key: $OMA_API_KEY" \
  -H "content-type: application/json" \
  -d "{\"agent_id\":\"$AGENT_ID\"}" | jq -r .id)

# 3. Send a message that triggers a sandbox operation
curl -s -X POST $OMA_BASE/v1/sessions/$SESSION_ID/events \
  -H "x-api-key: $OMA_API_KEY" \
  -H "content-type: application/json" \
  -d '{"events":[{"type":"user.message","content":[{"type":"text","text":"Run: echo hello from k8s && uname -a"}]}]}'

# 4. Verify the pod was created on the cluster
kubectl -n oma-sandbox get pods -l app.kubernetes.io/created-by=oma-k8s-bridge

# 5. Check k8s-bridge health for active box count
curl -H "Authorization: Bearer $K8S_BRIDGE_TOKEN" \
  https://k8s-bridge.example.com/api/v1/health | jq .active_boxes
```

### Troubleshooting

| Symptom | Likely Cause | Check |
|---|---|---|
| `k8s-bridge create failed: 401` | Wrong or missing token | Verify `K8S_BRIDGE_TOKEN` matches the Secret |
| `k8s-bridge create failed: 403` | RBAC misconfiguration | `kubectl auth can-i --list --as=system:serviceaccount:oma-sandbox:k8s-bridge` |
| Pod stuck in `Pending` | Insufficient cluster resources | `kubectl describe pod -n oma-sandbox <box-name>` |
| Exec hangs or times out | Pod not Ready yet | Check `kubectl get pods -n oma-sandbox -w` |
| `/api/v1/sandboxes/metrics` returns 500 | Metrics Server not installed | `kubectl get pods -n kube-system -l k8s-app=metrics-server` |
| Bridge pod crash looping | Invalid config or missing token secret | `kubectl -n oma-sandbox logs deployment/oma-k8s-bridge` |
