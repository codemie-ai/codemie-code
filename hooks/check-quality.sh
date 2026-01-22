#!/bin/bash
#
# Stop Hook: Code Quality Check
#
# Runs the EXACT same checks as git pre-commit hook:
# - lint-staged: ESLint on changed files (zero warnings)
# - vitest related: Tests for changed files only
# - license-check: Validate package.json licenses
# - validate:secrets: Gitleaks secret detection (if Docker available)
#
# Exit codes:
# 0 - All checks passed
# 1 - Non-blocking warnings (informational)
# 2 - Blocking errors (agent must fix before stopping)

set -e

# Get project directory from environment
PROJECT_DIR="${CODEMIE_PROJECT_DIR:-$(pwd)}"
cd "$PROJECT_DIR"

echo "🔍 Running code quality checks (matching git pre-commit)..."
echo "Project: $PROJECT_DIR"
echo ""

# Track if any checks failed
CHECKS_FAILED=0
FEEDBACK=""

# Check 1: lint-staged (ESLint + vitest related on changed files)
echo "📝 Running lint-staged (ESLint + tests on changed files)..."
if npx lint-staged 2>&1 | tee /tmp/lint-staged-output.txt; then
  echo "✅ lint-staged passed"
else
  CHECKS_FAILED=1
  LINT_ERRORS=$(cat /tmp/lint-staged-output.txt | tail -100)
  FEEDBACK="${FEEDBACK}lint-staged Errors:\n${LINT_ERRORS}\n\n"
  echo "❌ lint-staged failed"
fi

echo ""

# Check 2: License check (when package.json changed)
echo "📄 Running license check..."
if npm run license-check 2>&1 | tee /tmp/license-output.txt; then
  echo "✅ License check passed"
else
  CHECKS_FAILED=1
  LICENSE_ERRORS=$(cat /tmp/license-output.txt)
  FEEDBACK="${FEEDBACK}License Check Errors:\n${LICENSE_ERRORS}\n\n"
  echo "❌ License check failed"
fi

echo ""

# Check 3: Secrets detection (if Docker is available)
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  echo "🔍 Checking for secrets with Gitleaks..."
  if npm run validate:secrets 2>&1 | tee /tmp/secrets-output.txt; then
    echo "✅ No secrets detected"
  else
    CHECKS_FAILED=1
    SECRETS_ERRORS=$(cat /tmp/secrets-output.txt)
    FEEDBACK="${FEEDBACK}Secrets Detected:\n${SECRETS_ERRORS}\n\nPlease remove sensitive data (API keys, tokens, passwords).\n\n"
    echo "❌ Secrets detected"
  fi
else
  # Docker not available - provide helpful hints
  echo "⚠️  Docker not available - skipping secrets detection"
  if command -v colima >/dev/null 2>&1; then
    echo "💡 Colima is installed. Run 'colima start' to enable secrets detection"
  elif command -v podman >/dev/null 2>&1; then
    echo "💡 Podman is installed. Run 'podman machine start' to enable secrets detection"
  elif command -v orbstack >/dev/null 2>&1; then
    echo "💡 OrbStack is installed. Start OrbStack to enable secrets detection"
  elif command -v docker >/dev/null 2>&1; then
    echo "💡 Docker installed but not running. Start Docker to enable secrets detection"
  else
    echo "💡 Install Docker to enable local secrets detection (will run in CI)"
  fi
fi

echo ""

# Clean up temp files
rm -f /tmp/lint-staged-output.txt /tmp/license-output.txt /tmp/secrets-output.txt

# Return result
if [ $CHECKS_FAILED -eq 1 ]; then
  echo "❌ Code quality checks failed"
  echo ""
  # Limit feedback to prevent token overflow
  TRUNCATED_FEEDBACK=$(echo -e "$FEEDBACK" | head -200)
  echo "{\"decision\": \"block\", \"reason\": \"Code quality checks failed. Please fix the errors above.\", \"additionalContext\": \"$TRUNCATED_FEEDBACK\"}"
  exit 2
else
  echo "✅ All code quality checks passed"
  echo ""
  echo "{\"decision\": \"allow\", \"reason\": \"All code quality checks passed (matching git pre-commit)\"}"
  exit 0
fi
