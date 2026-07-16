# Kubernetes Deploy Guide

Scale OMA with Kubernetes sandbox pods using the k8s-bridge.

## Overview

The k8s-bridge is an HTTP bridge that lets Cloudflare Workers manage sandbox pods on a Kubernetes cluster. It runs as a Deployment inside your cluster and exposes a REST API that maps to Kubernetes operations.

```text
Cloudflare Worker → k8s-bridge (HTTPS + Bearer) → Kubernetes API → Pod
```

## Prerequisites

- Kubernetes cluster v1.25+
- Helm 3
- kubectl with cluster-admin access
- cert-manager installed
- DNS domain pointing to your ingress controller

## Install k8s-bridge

```bash
helm repo add oma https://charts.oma.duyet.net
helm repo update

export K8S_BRIDGE_TOKEN=$(openssl rand -base64 32)
echo "$K8S_BRIDGE_TOKEN"

helm install oma-k8s-bridge oma/oma-k8s-bridge \
  --namespace oma-sandbox \
  --create-namespace \
  --set secret.token=$K8S_BRIDGE_TOKEN \
  --set ingress.enabled=true \
  --set ingress.host=k8s-bridge.example.com
```

## Verify

```bash
kubectl -n oma-sandbox rollout status deployment/oma-k8s-bridge

curl -H "Authorization: Bearer $K8S_BRIDGE_TOKEN" \
  https://k8s-bridge.example.com/api/v1/health
```

Expected response:

```json
{"status":"ok","k8sVersion":"v1.30.2","nodeCount":3,"activeBoxes":0,"latencyMs":12}
```

## Configure OMA

In the Console, add a new sandbox provider:
1. Go to **Runtimes → Add Provider**
2. Select **Kubernetes (k8s-bridge)**
3. Enter URL: `https://k8s-bridge.example.com`
4. Enter token: the value printed by `echo "$K8S_BRIDGE_TOKEN"` above (paste the actual token, not the literal `$K8S_BRIDGE_TOKEN` text)

## Helm Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `replicaCount` | 2 | Number of replicas |
| `secret.token` | "" | Bearer token (REQUIRED) |
| `image.tag` | latest | Container image tag |
| `ingress.host` | "" | Ingress hostname |
| `resources.limits.cpu` | 500m | CPU limit |
| `resources.limits.memory` | 512Mi | Memory limit |

## Production Checklist

- [ ] Use a dedicated namespace (`oma-sandbox`)
- [ ] Set resource limits on the bridge pod
- [ ] Enable Pod Security Admission (`pod-security.kubernetes.io/enforce=restricted` namespace label — PodSecurityPolicy was removed in Kubernetes v1.25)
- [ ] Configure network policies
- [ ] Set up monitoring (Prometheus + Grafana)
- [ ] Regular backup of etcd
- [ ] Use a managed Kubernetes service (EKS, GKE, AKS)
