---
name: codemie-pr
description: Push changes and create PR using GitHub template. Use ONLY when user explicitly says "create PR", "make a PR", "push and create pull request", or similar explicit request. NEVER run proactively.
---

# CodeMie Pull Request Creator

Automate push and PR creation following the repository's PR template and git workflow standards.

**🚨 CRITICAL CONSTRAINT**: This skill should ONLY be invoked when the user EXPLICITLY requests creating a PR or push. NEVER run this proactively or suggest running it. Only execute when user explicitly asks.

## Reference Documentation

For complete git workflow details, see: `.codemie/guides/standards/git-workflow.md`

This includes:
- Branch naming conventions
- Commit message format (Conventional Commits)
- PR process and templates
- Code review checklist

## Pre-flight Checks

Before starting, verify:

1. **Current branch**: Must NOT be on `main`. If on main, stop and ask user to create a feature branch.
   ```bash
   git branch --show-current
   ```

   **Branch naming convention** (from git-workflow.md):
   - Format: `<type>/<kebab-case-description>`
   - Types: `feat/`, `fix/`, `refactor/`, `chore/`, `docs/`
   - Example: `feat/add-gemini-support`, `fix/npm-install-error`

2. **Changes committed**: Verify there are commits to push.
   ```bash
   # Check if there are unpushed commits
   git log origin/main..HEAD --oneline
   ```

3. **Working directory**: Warn if there are uncommitted changes.
   ```bash
   git status --short
   ```

4. **GitHub CLI availability**: Check if `gh` is installed.
   ```bash
   command -v gh >/dev/null 2>&1 && echo "available" || echo "not available"
   ```

## Pull Request Template

The repository uses a comprehensive PR template located at `.github/PULL_REQUEST_TEMPLATE.md`. The PR description should follow this structure:

### Template Structure:
```markdown
## Summary
[Brief overview of what this PR does and why]

## Changes
[Detailed list of changes with checkmarks, grouped by category]

### 🔧 [Category Name]
- ✅ [Specific change 1]
- ✅ [Specific change 2]

## Testing
- [ ] Tests pass
- [ ] Linter passes
- [ ] Manual testing performed

## Impact
[Optional: Show before/after examples for user-facing changes]

### Before
[Code or behavior before the change]

### After
[Code or behavior after the change]

### Benefits
- 🎯 [Benefit 1]
- 🔒 [Benefit 2]

## Checklist
- [x] Self-reviewed
- [ ] Manual testing performed
- [ ] Documentation updated (if needed)
- [ ] No breaking changes (or clearly documented)
```

## Execution Steps

Execute these steps in a **single message** with parallel tool calls:

### 1. Gather Context

```bash
# Current branch name
git branch --show-current

# Recent commits on this branch (not on main)
git log origin/main..HEAD --oneline

# Get PR template content
cat .github/PULL_REQUEST_TEMPLATE.md
```

### 2. Push to Origin

```bash
# Push current branch to origin (same branch name)
git push origin $(git branch --show-current)
```

### 3. Create Pull Request

Based on the commits, create a PR with a clear title and body following the template structure.

**Commit Message Format** (from git-workflow.md):
```
<type>(<scope>): <subject>
```

**Types** (required):
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `refactor`: Code refactoring
- `test`: Test additions/changes
- `chore`: Maintenance (deps, config, etc.)

**Scopes** (optional):
- `cli`, `agents`, `providers`, `config`, `proxy`, `workflows`, `analytics`, `utils`, `deps`, `tests`

**Examples**:
- `feat(agents): add Gemini plugin support`
- `fix: resolve npm timeout issues`
- `refactor(utils): consolidate path utilities`

#### Option A: Using GitHub CLI (if available)

```bash
gh pr create \
  --title "<type>(<scope>): brief description" \
  --body "$(cat <<'EOF'
## Summary

[Generated summary based on commits - 1-2 sentences explaining what and why]

## Changes

### 🔧 [Appropriate Category]
- ✅ [Change 1 from commits]
- ✅ [Change 2 from commits]

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

#### Option B: Using Git + Manual PR (if `gh` not available)

```bash
# Push the branch
git push origin $(git branch --show-current)

# Display PR creation URL
echo "Create PR manually at:"
echo "https://github.com/codemie-ai/codemie-code/compare/main...$(git branch --show-current)?expand=1"
```

Then inform the user to:
1. Open the URL in their browser
2. Use the following PR title: `<type>(<scope>): brief description`
3. Use the template body structure shown above

**Title Format Guidelines**:
- Use conventional commit format: `<type>(<scope>): <description>`
- Keep under 100 characters
- Use present tense, imperative mood
- Example: `feat(agents): add Gemini plugin support`

**Body Guidelines**:
1. **Summary**: 1-2 sentences explaining what and why
2. **Changes**: Categorize changes with emojis:
   - 🔧 Bug Fixes
   - ✨ Features
   - 📝 Documentation
   - 🧪 Testing
   - ♻️ Refactoring
3. **Testing**: List what testing was performed
4. **Impact** (optional): Include before/after for user-facing changes
5. **Checklist**: Mark "Self-reviewed" as checked, leave others for reviewer

## Completion

### If using GitHub CLI (`gh`):
1. Display the PR URL from `gh pr create` output
2. Remind user to:
   - Complete remaining checklist items
   - Request reviewers if needed
   - Monitor CI/CD checks

### If using Git only (no `gh`):
1. Display the GitHub compare URL for manual PR creation
2. Provide the formatted PR title and body text
3. Remind user to:
   - Open the URL and create PR manually
   - Copy/paste the provided title and body
   - Complete remaining checklist items
   - Request reviewers if needed

## Important Notes

- **ONLY** execute this skill when user explicitly requests PR creation
- All steps (push + PR creation) must be done in a **single message** with parallel tool calls
- Do NOT suggest or proactively run this skill
- Do NOT add extra tool calls or messages beyond what's needed for push + PR creation
- Check for `gh` CLI availability first and use appropriate method
- For complete git workflow details, always refer to `.codemie/guides/standards/git-workflow.md`
