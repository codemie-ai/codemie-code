#!/bin/sh
# Secrets detection using Gitleaks via Docker or Podman.
# Usage:
#   scripts/secrets-check.sh          # scan staged files
#   scripts/secrets-check.sh --git    # scan full git history

GITLEAKS_IMAGE="ghcr.io/gitleaks/gitleaks:v8.30.1"
CONTAINER_ENGINE=$(command -v docker 2>/dev/null || command -v podman 2>/dev/null)

if [ -z "$CONTAINER_ENGINE" ]; then
  echo "No suitable container engine found - skipping secrets detection"
  echo "Install Docker to enable local secrets scanning"
  exit 1
fi

if ! $CONTAINER_ENGINE info >/dev/null 2>&1; then
  if command -v colima >/dev/null 2>&1; then
    echo "Docker daemon not running - Colima is installed"
    echo "Run 'colima start' to enable secrets detection locally"
  elif command -v podman >/dev/null 2>&1; then
    echo "Docker daemon not running - Podman is installed"
    echo "Run 'podman machine start' to enable secrets detection locally"
  elif command -v orbstack >/dev/null 2>&1; then
    echo "Docker daemon not running - OrbStack is installed"
    echo "Start OrbStack to enable secrets detection locally"
  else
    echo "Container engine found but daemon is not running"
  fi
  exit 1
fi

echo "Checking for secrets with Gitleaks..."

if [ "$1" = "--git" ]; then
  $CONTAINER_ENGINE run --rm -v "$(pwd):/path" "$GITLEAKS_IMAGE" git --no-banner --verbose /path
else
  $CONTAINER_ENGINE run --rm -v "$(pwd):/path" "$GITLEAKS_IMAGE" dir --no-banner --verbose /path
fi

if [ $? -ne 0 ]; then
  echo "Secrets detected! Please remove sensitive data before committing."
  exit 1
fi
