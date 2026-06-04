#!/usr/bin/env bash
# Build the carein-caddy image in ACR. Self-contained: the Dockerfile builds the
# SPA itself (stage 1), so there is nothing to pre-build — just point az acr build
# at the repo root with the multi-stage Dockerfile.
#
# Usage:
#   deploy/container/azure/build-caddy-image.sh <acr-name> <image:tag>
# Example:
#   deploy/container/azure/build-caddy-image.sh acrcareincore carein-caddy:s3-abc1234
set -euo pipefail

ACR="${1:?usage: build-caddy-image.sh <acr-name> <image:tag>}"
TAG="${2:?usage: build-caddy-image.sh <acr-name> <image:tag>}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

az acr build -r "$ACR" -t "$TAG" \
  -f "$REPO_ROOT/deploy/container/azure/Dockerfile.caddy" "$REPO_ROOT"
