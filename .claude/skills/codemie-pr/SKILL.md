---
name: codemie-pr
description: >-
  Manages git commits, pushes, and GitHub PR creation following conventional commits.
  Use when user says "commit changes", "push changes", "create PR", "make a pull request",
  or similar git workflow requests. Understands current branch state and avoids duplicate PRs.
---

# CodeMie Pull Request Workflow

## Instructions

### 1. Check Current State

Always start by checking git status:

```bash
# Current branch
git branch --show-current

# Uncommitted changes
git status --short

# Existing PR for current branch
gh pr list --head $(git branch --show-current) 2>/dev/null || echo "No PR"
```

### 2. Handle Based on User Request

**"commit changes"** → Commit only:
```bash
git add .
git commit -m "<type>(<scope>): <description>"
```

**"push changes"** → Push only:
```bash
git push origin $(git branch --show-current)
```

**"create PR"** → Full workflow below.

### 3. Create PR Workflow

#### If on `main` branch:
1. Create feature branch first: `git checkout -b <type>/<description>`
2. Then proceed with commit/push/PR

#### If PR already exists:
```bash
git push origin $(git branch --show-current)
# Inform: "Changes pushed to existing PR: <url>"
```

#### If no PR exists:
```bash
# Push changes
git push origin $(git branch --show-current)

# Create PR - read .github/PULL_REQUEST_TEMPLATE.md for structure
gh pr create \
  --title "<type>(<scope>): brief description" \
  --body "$(cat <<'EOF'
[Fill template from .github/PULL_REQUEST_TEMPLATE.md]
EOF
)"
```

**Template location**: `.github/PULL_REQUEST_TEMPLATE.md`

Read the template file and fill all sections based on commits and changes.

## Commit Format

**Pattern**: `<type>(<scope>): <subject>`

**Types**:
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation
- `refactor`: Code refactoring
- `test`: Tests
- `chore`: Maintenance

**Scopes** (optional): `cli`, `agents`, `providers`, `config`, `workflows`, `utils`, `deps`

**Examples**:
```bash
git commit -m "feat(agents): add Gemini plugin support"
git commit -m "fix: resolve npm timeout issues"
git commit -m "docs(readme): update installation steps"
```

## Branch Format

**Pattern**: `<type>/<description>`

**Examples**:
- `feat/add-gemini-support`
- `fix/npm-install-error`
- `docs/update-readme`

## Troubleshooting

### Error: "gh: command not found"
**Solution**: Create PR manually at:
```
https://github.com/codemie-ai/codemie-code/compare/main...<branch>?expand=1
```
Use structure from `.github/PULL_REQUEST_TEMPLATE.md` for PR body.

### Error: Already on main branch
**Solution**: Create feature branch first:
```bash
git checkout -b <type>/<short-description>
```

### Error: No changes to commit
**Solution**: Check `git status` - nothing to commit or changes already staged.

### PR already exists
**Action**: Just push updates to existing PR, don't create new one.

## Examples

**User**: "commit the auth changes"
```bash
git add .
git commit -m "feat(auth): add OAuth2 support"
```

**User**: "push and create PR"
1. Check for existing PR
2. If none: Read `.github/PULL_REQUEST_TEMPLATE.md`, fill sections, create PR
3. If exists: Push to existing PR

**User**: "create PR for the bug fix"
1. Verify not on main
2. Push changes
3. Read template, create PR with `fix(...)` title
