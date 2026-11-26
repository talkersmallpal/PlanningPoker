# Deploy Planning Poker on Kubernetes

The step-by-step guide (image build/push, namespace, Secret, ConfigMap, PVC, Deployment, Service, Ingress, `kubectl apply -k k8s/`, upgrade and verification) and the full environment variable table are in the main [README](../README.md#4-deploy-on-kubernetes). This page is a short version plus security notes.

This folder is a single-replica Deployment for the self-hosted planning poker app. State lives in the process (WebSockets) and in a JSON file on a PersistentVolume, so **run exactly one replica**.

The container image is Linux/amd64, runs as the non-root `node` user (uid/gid **1000**), and has been verified with a read-only root filesystem (only `/data` needs to be writable).

## 1. Load, tag and push the amd64 image

On a machine that can reach your registry, from the folder that has the tarball (reassemble split parts first if needed):

```bash
# If you received split parts:
cat planning-poker-1.0.0-amd64.tar.gz.part* > planning-poker-1.0.0-amd64.tar.gz

# compare with the sha256 published in the release notes
shasum -a 256 planning-poker-1.0.0-amd64.tar.gz

docker load -i planning-poker-1.0.0-amd64.tar.gz
# -> planning-poker:1.0.0-amd64

# Replace REGISTRY with yours, e.g. registry.example.com/planning-poker
# or ghcr.io/org/planning-poker
export REGISTRY=registry.example.com
docker tag planning-poker:1.0.0-amd64 "$REGISTRY/planning-poker:1.0.0"
docker push "$REGISTRY/planning-poker:1.0.0"
```

The cluster nodes must be amd64 (`uname -m` is `x86_64`). For an ARM cluster, use the arm64 tarball and tag that instead.

Edit `deployment.yaml` (or the `images:` block in `kustomization.yaml`) and replace `REGISTRY` with the same registry you pushed to.

## 2. Create the Secret (do not apply secret.example.yaml)

`secret.example.yaml` is a template only and is **not** included in `kustomization.yaml`. Create the live secret with real values in your shell (they will not be echoed back here):

```bash
kubectl create namespace planning-poker --dry-run=client -o yaml | kubectl apply -f -

kubectl -n planning-poker create secret generic planning-poker \
  --from-literal=ADMIN_PASSWORD='...' \
  --from-literal=JIRA_EMAIL='service-account@example.com' \
  --from-literal=JIRA_API_TOKEN='...'
```

Leave `JIRA_EMAIL` / `JIRA_API_TOKEN` empty (`--from-literal=JIRA_EMAIL=` and the same for the token) if you want to run without Jira.

## 3. Adjust the ConfigMap, then apply

Edit `configmap.yaml` for your Jira site (e.g. `https://url1`), default JQL, default board by name (`JIRA_DEFAULT_BOARD`) and project (`JIRA_DEFAULT_BOARD_PROJECT`), default session name and rate, the default **Update in Jira** mode (`JIRA_UPDATE_DEFAULT_MODE`: `sp`, `time` or `both`) and whether the Remaining estimate is recalculated (`JIRA_RECALC_REMAINING`, default `"true"`). Then:

```bash
# Preview
kubectl kustomize k8s/

# Deploy
kubectl apply -k k8s/
```

If you apply the example Ingress, also change the host `poker.example.com` and point `secretName: planning-poker-tls` at a real TLS secret (or add cert-manager annotations). Until DNS and TLS are ready, skip the Ingress and use port-forward (below). To skip Ingress entirely, remove `- ingress.yaml` from `kustomization.yaml` before applying.

## 4. Try it with port-forward

```bash
kubectl -n planning-poker rollout status deploy/planning-poker
kubectl -n planning-poker port-forward svc/planning-poker 8080:80
# open http://127.0.0.1:8080
```

WebSockets work over the same port (`/ws`).

## Notes

- **One replica only.** Session state and votes are held in memory and persisted to `/data/sessions.json`. The Deployment uses `strategy: Recreate` so two pods never share the volume or split WebSocket connections. Do not raise `replicas`. If you later sit this behind more than one ingress pod, enable sticky sessions on the Ingress so a given browser keeps reaching the same backend during a vote.
- **Non-root.** The image `USER` is `node` (uid/gid 1000, the standard `node:20-alpine` user). The pod and container `securityContext` set `runAsNonRoot`, `runAsUser` / `runAsGroup` / `fsGroup` 1000, drop all capabilities, and `readOnlyRootFilesystem: true`. `fsGroup: 1000` makes the PVC writable by that user. No extra `/tmp` volume is required.
- **Probes.** Liveness and readiness call `GET /healthz` on port 8080.
- **Optional env** not in the ConfigMap (set as extra `env:` if you need them): `JIRA_WRITE_ORIGINAL_ESTIMATE` (default true), `JIRA_TIMEOUT_SECONDS` (default 15), `HOST` (default `0.0.0.0`). See the env table in the main README.
- **Verify:** `kubectl -n planning-poker logs deploy/planning-poker`, then via port-forward `curl -s http://127.0.0.1:8080/healthz` (shows the version) and `curl -s http://127.0.0.1:8080/api/jira/status`.
- **Upgrade:** push the new image, bump `newTag` in `kustomization.yaml`, `kubectl apply -k k8s/`, `kubectl -n planning-poker rollout status deploy/planning-poker`. The PVC keeps sessions.
