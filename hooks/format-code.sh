#!/bin/bash
#
# PostToolUse Hook: Auto-Format Code
#
# Automatically runs ESLint --fix on modified TypeScript files after tool execution.
# Triggers on: Write, Edit, NotebookEdit tools (file modification operations)
#
# Exit codes:
# 0 - Success (formatting applied or not needed)
# 1 - Non-blocking warning (informational)

# Get project directory and tool info from environment
PROJECT_DIR="${CODEMIE_PROJECT_DIR:-$(pwd)}"
TOOL_NAME="${CODEMIE_TOOL_NAME:-}"
TOOL_INPUT="${CODEMIE_HOOK_INPUT:-}"

cd "$PROJECT_DIR"

# Only run on file modification tools
case "$TOOL_NAME" in
  Write|Edit|NotebookEdit)
    echo "📝 Auto-formatting code after $TOOL_NAME..."
    ;;
  *)
    # Not a file modification tool, skip formatting
    exit 0
    ;;
esac

# Extract file path from tool input
FILE_PATH=""
if [ -n "$TOOL_INPUT" ]; then
  # Parse JSON input to get file_path or notebook_path
  FILE_PATH=$(echo "$TOOL_INPUT" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty' 2>/dev/null)
fi

# If no file path found, try to get it from tool output
if [ -z "$FILE_PATH" ]; then
  echo "⚠️  Could not determine file path, skipping auto-format"
  exit 0
fi

# Check if file is a TypeScript file
if [[ ! "$FILE_PATH" =~ \.ts$ ]]; then
  echo "ℹ️  File is not TypeScript ($FILE_PATH), skipping format"
  exit 0
fi

# Make path absolute if relative
if [[ ! "$FILE_PATH" =~ ^/ ]]; then
  FILE_PATH="$PROJECT_DIR/$FILE_PATH"
fi

# Check if file exists
if [ ! -f "$FILE_PATH" ]; then
  echo "⚠️  File not found: $FILE_PATH"
  exit 0
fi

echo "🔧 Formatting: $FILE_PATH"

# Run ESLint --fix on the specific file
if npx eslint "$FILE_PATH" --fix 2>&1; then
  echo "✅ Code formatted successfully"

  # Check if file was modified by ESLint
  if git diff --quiet "$FILE_PATH" 2>/dev/null; then
    echo "ℹ️  No formatting changes needed"
  else
    echo "✨ Applied formatting fixes"
  fi
else
  # ESLint failed, but don't block (maybe file has syntax errors)
  echo "⚠️  ESLint could not format (file may have syntax errors)"
fi

# Always return success (formatting is best-effort, not required)
echo '{"decision": "allow"}'
exit 0
