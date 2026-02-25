#!/bin/bash
#
# Stop Hook Example: Check for uncommitted changes
#
# This hook prevents the agent from stopping if there are uncommitted git changes.
# It demonstrates blocking behavior and conditional logic in Stop hooks.
#
# Usage:
# 1. Make executable: chmod +x stop-check-git.sh
# 2. Add to your profile configuration
#

# Get current working directory from hook input
CWD=$(echo "$CODEMIE_HOOK_INPUT" | jq -r '.cwd' 2>/dev/null || pwd)

# Change to working directory
cd "$CWD" || {
  echo '{"decision": "allow", "reason": "Could not access working directory"}'
  exit 0
}

# Check if this is a git repository
if [ ! -d .git ]; then
  # Not a git repo, allow stopping
  echo '{"decision": "allow"}'
  exit 0
fi

# Check for uncommitted changes
if git diff --quiet && git diff --cached --quiet; then
  # No uncommitted changes, allow stopping
  echo ""
  echo "✅ All changes committed. Good job!"
  echo ""
  echo '{"decision": "allow"}'
  exit 0
else
  # Uncommitted changes detected, block stopping
  CHANGES=$(git status --short | wc -l | tr -d ' ')
  
  echo ""
  echo "⚠️  Warning: $CHANGES uncommitted change(s) detected"
  echo ""
  echo "Run 'git status' to see changes"
  echo ""
  
  # Block stopping and provide reason to agent
  cat <<'EOF'
{
  "decision": "block",
  "reason": "There are uncommitted changes in the repository. Please review and commit your changes before completing:\n\n1. Run 'git status' to see changes\n2. Stage changes with 'git add .'\n3. Commit with 'git commit -m \"your message\"'\n\nOr if you want to stop anyway, you can run 'git stash' to save changes for later."
}
EOF
  exit 0
fi
