#!/bin/bash
#
# Stop Hook: Code Quality Check
#
# Runs the same checks as git pre-commit hook:
# - ESLint (zero warnings required)
# - Tests (vitest)
#
# Exit codes:
# 0 - All checks passed
# 1 - Non-blocking warnings (informational)
# 2 - Blocking errors (agent must fix before stopping)

set -e

# Get project directory from environment
PROJECT_DIR="${CODEMIE_PROJECT_DIR:-$(pwd)}"
cd "$PROJECT_DIR"

echo "🔍 Running code quality checks..."
echo "Project: $PROJECT_DIR"
echo ""

# Track if any checks failed
CHECKS_FAILED=0
FEEDBACK=""

# Check 1: ESLint
echo "📝 Running ESLint..."
if npm run lint 2>&1 | tee /tmp/eslint-output.txt; then
  echo "✅ ESLint passed"
else
  CHECKS_FAILED=1
  ESLINT_ERRORS=$(cat /tmp/eslint-output.txt)
  FEEDBACK="${FEEDBACK}ESLint Errors:\n${ESLINT_ERRORS}\n\n"
  echo "❌ ESLint failed"
fi

echo ""

# Check 2: Tests
echo "🧪 Running tests..."
if npm test 2>&1 | tee /tmp/test-output.txt; then
  echo "✅ Tests passed"
else
  CHECKS_FAILED=1
  TEST_ERRORS=$(tail -50 /tmp/test-output.txt)
  FEEDBACK="${FEEDBACK}Test Failures:\n${TEST_ERRORS}\n\n"
  echo "❌ Tests failed"
fi

echo ""

# Clean up temp files
rm -f /tmp/eslint-output.txt /tmp/test-output.txt

# Return result
if [ $CHECKS_FAILED -eq 1 ]; then
  echo "❌ Code quality checks failed"
  echo ""
  echo "{\"decision\": \"block\", \"reason\": \"Code quality checks failed\", \"additionalContext\": \"$(echo -e "$FEEDBACK" | head -100)\"}"
  exit 2
else
  echo "✅ All code quality checks passed"
  echo ""
  echo "{\"decision\": \"allow\", \"reason\": \"All code quality checks passed\"}"
  exit 0
fi
