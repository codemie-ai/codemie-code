---
name: codemie-pr
description: Push changes and create PR using GitHub template. Use ONLY when user explicitly says "commit changes", "create PR", "make a PR", "push and create pull request", or similar explicit request. NEVER run proactively.
---

# CodeMie Pull Request Creator

**🚨 CRITICAL CONSTRAINT**: ONLY execute when user explicitly requests PR creation or commit. NEVER run proactively.

## Reference Documentation

Complete git workflow details: `.codemie/guides/standards/git-workflow.md`

## User Request Scenarios

### Scenario 1: Commit Only
User says: "commit the changes", "commit these files", "make a commit"

**Action**: Create commit, do NOT push or create PR
```bash
git add .
git commit -m "<type>(<scope>): <description>"
```

### Scenario 2: Push Changes
User says: "push changes", "push to remote"

**Action**: Push to origin, do NOT create PR
```bash
git push origin $(git branch --show-current)
```

### Scenario 3: Create PR
User says: "create PR", "make a pull request"

**Action**: Check for existing PR, then push and create PR if needed

## Pre-flight Checks

```bash
# 1. Current branch (must NOT be main)
git branch --show-current

# 2. Check for existing PR
gh pr list --head $(git branch --show-current) 2>/dev/null || echo "No PR found"

# 3. Uncommitted changes
git status --short

# 4. Unpushed commits
git log origin/main..HEAD --oneline

# 5. Check gh CLI availability
command -v gh >/dev/null 2>&1 && echo "available" || echo "not available"
```

## Branch & Commit Format

**Branch**: `<type>/<description>` (e.g., `feat/add-feature`, `fix/bug-name`)

**Commit**: `<type>(<scope>): <subject>` (e.g., `feat(agents): add new feature`)

**Types**: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`

See `.codemie/guides/standards/git-workflow.md` for complete details.

## PR Creation Flow

### If PR Already Exists:
```bash
# Just push changes
git push origin $(git branch --show-current)

# Inform user
echo "PR already exists: <PR_URL>"
echo "Changes pushed to existing PR."
```

### If No PR Exists:

#### Option A: With `gh` CLI
```bash
# 1. Push changes
git push origin $(git branch --show-current)

# 2. Create PR
gh pr create \
  --title "<type>(<scope>): brief description" \
  --body "$(cat <<'EOF'
## Summary
[1-2 sentence summary based on commits]

## Changes
### 🔧 [Category]
- ✅ [Change from commits]

## Testing
- [ ] Tests pass
- [ ] Linter passes
- [ ] Manual testing performed

## Checklist
- [x] Self-reviewed
- [ ] Manual testing performed
- [ ] Documentation updated (if needed)
- [ ] No breaking changes (or clearly documented)
EOF
)"
```

#### Option B: Without `gh` CLI
```bash
# 1. Push changes
git push origin $(git branch --show-current)

# 2. Display manual PR URL
echo "Create PR at:"
echo "https://github.com/codemie-ai/codemie-code/compare/main...$(git branch --show-current)?expand=1"
```

Then provide formatted title and body following `.github/PULL_REQUEST_TEMPLATE.md`.

## Category Emojis

- 🔧 Bug Fixes
- ✨ Features
- 📝 Documentation
- 🧪 Testing
- ♻️ Refactoring

## Important Notes

- **Check for existing PR** before creating new one
- **Match user intent**: commit-only vs push vs create PR
- **Single message execution**: All tool calls in one message
- **Reference template**: Use `.github/PULL_REQUEST_TEMPLATE.md` structure
- **Reference workflow**: See `.codemie/guides/standards/git-workflow.md`
