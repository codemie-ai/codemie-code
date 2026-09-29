#!/usr/bin/env bash
set -euo pipefail

PACKAGE_NAME="@codemieai/code"
MINIMUM_NODE_MAJOR="20"
REGISTRY_URL="${CODEMIE_REGISTRY_URL:-https://registry.npmjs.org/}"
SCOPE_REGISTRY_URL="${CODEMIE_SCOPE_REGISTRY_URL:-}"
INSTALL_MODE="${CODEMIE_INSTALL_MODE:-auto}"
USER_PREFIX="${CODEMIE_NPM_PREFIX:-$HOME/.codemie/npm-prefix}"
LEGACY_PREFIX="$HOME/.codemie/npm-prefix"
PACKAGE_VERSION="${CODEMIE_PACKAGE_VERSION:-}"

status() {
  printf '%-18s %s\n' "$1:" "$2"
}

command_path() {
  command -v "$1" 2>/dev/null || true
}

user_npmrc_prefix() {
  local user_config
  user_config="$(npm config get userconfig 2>/dev/null || true)"
  [ -f "$user_config" ] || return 0
  sed -n -E 's/^[[:space:]]*prefix[[:space:]]*=[[:space:]]*"?([^"]*)"?[[:space:]]*$/\1/p' "$user_config" | tail -n 1
}

node_major() {
  local version
  version="$(node --version 2>/dev/null || true)"
  case "$version" in
    v[0-9]*)
      echo "$version" | sed -E 's/^v([0-9]+).*/\1/'
      ;;
    *)
      echo "0"
      ;;
  esac
}

NODE_PATH="$(command_path node)"
NPM_PATH="$(command_path npm)"
NODE_MAJOR="$(node_major)"

echo "CodeMie installer diagnostics"
status "OS" "$(uname -s)-$(uname -m)"
status "Shell" "POSIX"
status "Node" "${NODE_PATH:-not found} major $NODE_MAJOR"
status "npm" "${NPM_PATH:-not found}"
status "Registry" "$REGISTRY_URL"

if [ -z "$NODE_PATH" ] || [ "$NODE_MAJOR" -lt "$MINIMUM_NODE_MAJOR" ]; then
  echo "Node.js $MINIMUM_NODE_MAJOR or newer is required. Install Node.js using the approved enterprise method, then rerun this installer." >&2
  exit 1
fi

if [ -z "$NPM_PATH" ]; then
  echo "npm was not found. Reinstall Node.js with npm enabled, then rerun this installer." >&2
  exit 1
fi

if [ -n "$SCOPE_REGISTRY_URL" ]; then
  npm config set '@codemieai:registry' "$SCOPE_REGISTRY_URL" --location user
  echo "Revert: npm config delete @codemieai:registry --location user"
fi

LEGACY_OVERRIDE_DETECTED=0
if [ "$(user_npmrc_prefix)" = "$LEGACY_PREFIX" ]; then
  LEGACY_OVERRIDE_DETECTED=1
  echo "Legacy npm prefix override detected at $LEGACY_PREFIX"
  if [ -d "$LEGACY_PREFIX" ]; then
    echo "Packages stranded in the legacy prefix:"
    npm ls -g --prefix "$LEGACY_PREFIX" --depth=0 || true
  fi
  if ! npm config delete prefix --location user; then
    echo "Failed to delete the legacy npm prefix override." >&2
    exit 1
  fi
  status "npm config" "removed the user prefix override"
  echo "Revert: npm config set prefix \"$LEGACY_PREFIX\" --location user"
fi

if [ "$INSTALL_MODE" = "auto" ]; then
  NPM_PREFIX="$(npm config get prefix)"
  if [ -w "$NPM_PREFIX" ]; then
    INSTALL_MODE="npm-global"
  else
    INSTALL_MODE="user-prefix"
  fi
fi

status "Install mode" "$INSTALL_MODE"

if [ "$INSTALL_MODE" = "user-prefix" ]; then
  mkdir -p "$USER_PREFIX/bin"
  case ":$PATH:" in
    *":$USER_PREFIX/bin:"*)
      status "PATH update" "already present"
      ;;
    *)
      status "PATH update" "add $USER_PREFIX/bin to PATH in your shell profile"
      ;;
  esac
fi

PACKAGE_SPEC="$PACKAGE_NAME"
if [ -n "$PACKAGE_VERSION" ]; then
  PACKAGE_SPEC="$PACKAGE_NAME@$PACKAGE_VERSION"
fi

if ! RESOLVED_PACKAGE_VERSION="$(npm view "$PACKAGE_SPEC" version --registry "$REGISTRY_URL" 2>&1)"; then
  echo "Package $PACKAGE_SPEC was not found in registry $REGISTRY_URL." >&2
  echo "Ask IT to expose @codemieai/code through the approved virtual npm repository, or rerun with CODEMIE_SCOPE_REGISTRY_URL pointing to the approved registry." >&2
  echo "npm output: $RESOLVED_PACKAGE_VERSION" >&2
  exit 1
fi

RESOLVED_PACKAGE_VERSION="$(printf '%s\n' "$RESOLVED_PACKAGE_VERSION" | head -n 1)"
status "Package" "$PACKAGE_SPEC found ($RESOLVED_PACKAGE_VERSION)"

INSTALL_ARGS=(install -g "$PACKAGE_SPEC" --registry "$REGISTRY_URL")
INSTALL_PREFIX=""
if [ "$INSTALL_MODE" = "user-prefix" ]; then
  INSTALL_PREFIX="$USER_PREFIX"
  INSTALL_ARGS+=(--prefix "$INSTALL_PREFIX")
fi

if ! npm "${INSTALL_ARGS[@]}"; then
  echo "Failed to install $PACKAGE_SPEC from registry $REGISTRY_URL." >&2
  exit 1
fi

status "CodeMie" "installed $RESOLVED_PACKAGE_VERSION"

if [ "$LEGACY_OVERRIDE_DETECTED" = "1" ] && [ "$INSTALL_PREFIX" != "$LEGACY_PREFIX" ]; then
  echo "Reinstall stranded packages, for example: npm i -g @anthropic-ai/claude-code@latest"
  echo "Optional cleanup: rm -rf \"$LEGACY_PREFIX\""
  case ":$PATH:" in
    *":$LEGACY_PREFIX/bin:"*)
      status "PATH cleanup" "remove $LEGACY_PREFIX/bin from your shell profile PATH"
      ;;
  esac
fi

echo "Run `codemie doctor` in a new terminal to verify the installation."
