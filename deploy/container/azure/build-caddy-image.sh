#!/usr/bin/env bash
# Build the carein-caddy image in ACR with a minimal upload context.
#
# Assembles a tiny build dir (Dockerfile.caddy + Caddyfile + the prebuilt SPA)
# and runs `az acr build`, so we never upload node_modules or the whole repo.
#
# Prereqs: build the SPA first with the same-origin API base —
#   cd new-dashboard && VITE_API_URL=/api pnpm exec vite build   (-> dist/public)
#
# Usage:
#   deploy/container/azure/build-caddy-image.sh <acr-name> <image-tag>
# Example:
#   deploy/container/azure/build-caddy-image.sh acrcareincore carein-caddy:s2-abc1234
set -euo pipefail

ACR="${1:?usage: build-caddy-image.sh <acr-name> <image:tag>}"
TAG="${2:?usage: build-caddy-image.sh <acr-name> <image:tag>}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SPA_DIST="$REPO_ROOT/new-dashboard/dist/public"
[ -f "$SPA_DIST/index.html" ] || { echo "ERROR: build the SPA first ($SPA_DIST/index.html missing)"; exit 1; }

CTX="$(mktemp -d)"
trap 'rm -rf "$CTX"' EXIT
cp "$REPO_ROOT/deploy/container/azure/Dockerfile.caddy" "$CTX/Dockerfile"
cp "$REPO_ROOT/deploy/container/Caddyfile" "$CTX/Caddyfile"
cp -r "$SPA_DIST" "$CTX/srv"

echo "Building $TAG in ACR $ACR from $CTX ..."
az acr build -r "$ACR" -t "$TAG" "$CTX"
