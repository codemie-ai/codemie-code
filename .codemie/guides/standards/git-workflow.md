# Git Workflow

## Quick Summary

Git workflow for CodeMie Code: branching strategy, conventional commits, pull requests, and code review.

**Category**: Standards
**Complexity**: Simple
**Prerequisites**: Git basics

---

## Branching Strategy

| Branch Type | Pattern | Purpose | Example |
|-------------|---------|---------|---------|
| Main | `main` | Production-ready code | `main` |
| Feature | `feat/[description]` | New features | `feat/add-gemini-support` |
| Fix | `fix/[description]` | Bug fixes | `fix/npm-install-error` |
| Refactor | `refactor/[description]` | Code refactoring | `refactor/utils-consolidation` |
| Chore | `chore/[description]` | Maintenance tasks | `chore/update-deps` |
| Docs | `docs/[description]` | Documentation | `docs/update-readme` |

**Project Pattern**: `<type>/<kebab-case-description>`

---

## Workflow

```bash
# 1. Create branch from main
git checkout main
git pull origin main
git checkout -b feat/add-new-feature

# 2. Work & commit (multiple commits OK)
git add src/feature.ts
git commit -m "feat(agents): add new feature"

# 3. Keep branch updated
git fetch origin
git rebase origin/main

# 4. Push to remote
git push origin feat/add-new-feature

# 5. Create PR via GitHub
gh pr create --title "feat(agents): add new feature" --body "..."
```

---

## Commit Message Format

### Conventional Commits

```
<type>(<scope>): <subject>

[optional body]

[optional footer]
```

**Types** (required):
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style (formatting, whitespace)
- `refactor`: Code refactoring
- `perf`: Performance improvements
- `test`: Test additions/changes
- `chore`: Maintenance (deps, config, etc.)
- `ci`: CI/CD changes
- `revert`: Revert previous commits

**Scopes** (optional):
- `cli`: CLI commands
- `agents`: Agent system
- `providers`: Provider plugins
- `config`: Configuration
- `proxy`: Proxy system
- `workflows`: Workflows
- `analytics`: Analytics
- `utils`: Utilities
- `deps`: Dependencies
- `tests`: Test infrastructure

### Examples

```bash
# Feature with scope
git commit -m "feat(agents): add Gemini plugin support"

# Fix without scope
git commit -m "fix: resolve npm timeout issues"

# Breaking change
git commit -m "feat(providers): change LiteLLM config format

BREAKING CHANGE: LiteLLM now requires baseUrl in config"

# Multiple lines
git commit -m "refactor(utils): consolidate path utilities

- Merged path-utils, codemie-home, dirname into paths.ts
- Preserved git history via git mv
- All 575 tests passing"
```

---

## Commit Rules

| ✅ DO | ❌ DON'T |
|-------|----------|
| Make atomic commits | Mix unrelated changes |
| Write descriptive messages | "fix stuff", "wip" |
| Use present tense | Past tense ("added", "fixed") |
| Reference issues (#123) | Skip context |
| Keep subject under 100 chars | Long subjects |
| Explain "why" in body | Explain "what" (code shows that) |

---

## Pull Request Process

### PR Title Format

```
<type>(<scope>): <description>
```

Must match commit message format.

### PR Description Template

```markdown
## Summary
Brief description of changes (2-3 sentences)

## Changes
- Added feature X
- Refactored module Y
- Fixed bug Z

## Test Plan
- [ ] Unit tests added/updated
- [ ] Integration tests pass
- [ ] Manual testing done

## Checklist
- [ ] Code follows style guide
- [ ] All tests pass (`npm run ci`)
- [ ] No ESLint warnings
- [ ] Documentation updated
- [ ] No merge conflicts
```

### Creating PR with GitHub CLI

```bash
# Create PR
gh pr create \
  --title "feat(agents): add Gemini support" \
  --body "$(cat <<'EOF'
## Summary
Adds Google Gemini AI integration as a new agent plugin.

## Changes
- Added GeminiPlugin implementation
- Added extension installer for VSCode
- Added session tracking adapter

## Test Plan
- [x] Unit tests for Gemini plugin
- [x] Integration test for installation
- [x] Manual testing with Gemini API

## Checklist
- [x] Code follows style guide
- [x] All tests pass
- [x] Documentation updated
EOF
)"

# View PR
gh pr view --web
```

---

## Code Review Checklist

### For Reviewers

- [ ] **Functionality**: Does it work as intended?
- [ ] **Code Quality**: Follows standards, no code smells?
- [ ] **Tests**: Adequate coverage, tests pass?
- [ ] **Security**: No hardcoded secrets, proper validation?
- [ ] **Documentation**: Comments, README updates?
- [ ] **Performance**: No obvious bottlenecks?
- [ ] **Breaking Changes**: Documented, necessary?

### For Authors

Before requesting review:
- [ ] All tests pass (`npm run ci`)
- [ ] No ESLint warnings
- [ ] Self-review completed
- [ ] PR description is clear
- [ ] Commits are clean and atomic
- [ ] Branch is up to date with main

---

## Merge Strategy

**Project Standard**: Squash and Merge

```bash
# After PR approval (via GitHub UI or CLI)
gh pr merge --squash --delete-branch

# Or via UI: Click "Squash and merge"
```

**Why Squash?**
- Keeps main branch history clean
- One commit per PR
- Easier to revert if needed

**Cleanup After Merge**:
```bash
git checkout main
git pull origin main
git branch -d feat/old-feature  # Delete local branch
```

---

## Common Git Commands

### Daily Workflow

```bash
# Check status
git status

# Stage files
git add src/file.ts
git add .  # All changes

# Commit
git commit -m "feat: add feature"

# Push
git push origin feat/branch-name

# Pull latest from main
git checkout main
git pull origin main
```

### Advanced Operations

```bash
# Undo last commit (keep changes)
git reset --soft HEAD~1

# Amend last commit
git commit --amend -m "new message"

# Rebase on main
git fetch origin
git rebase origin/main

# Interactive rebase (squash commits)
git rebase -i HEAD~3

# Cherry-pick commit
git cherry-pick <commit-hash>

# Stash changes
git stash
git stash pop
```

### Branch Management

```bash
# List branches
git branch -a

# Switch branch
git checkout branch-name

# Create and switch
git checkout -b feat/new-branch

# Delete local branch
git branch -d feat/old-branch

# Delete remote branch
git push origin --delete feat/old-branch
```

---

## Commit Message Validation

**Automated via commitlint**:

```bash
# Runs automatically on commit (via Husky)
# Validates format: <type>(<scope>): <subject>

# Manual check
npx commitlint --from HEAD~1 --to HEAD --verbose

# Check specific message
echo "feat: add feature" | npx commitlint
```

**Configuration**: `commitlint.config.cjs`

---

## Best Practices

### Commit Frequency

- ✅ Commit often (small, logical units)
- ✅ Each commit should be buildable
- ✅ Each commit should pass tests
- ❌ Don't commit broken code
- ❌ Don't commit debugging code

### Branch Management

- ✅ Keep branches short-lived (< 1 week)
- ✅ Rebase on main regularly
- ✅ Delete merged branches
- ❌ Don't work directly on main
- ❌ Don't let branches get stale

### Commit Messages

- ✅ First line summary (< 100 chars)
- ✅ Blank line before body
- ✅ Body explains why, not what
- ✅ Reference issues (Closes #123)
- ❌ Don't use vague messages

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Merge conflicts | Rebase on main: `git rebase origin/main` |
| Wrong branch | Cherry-pick to correct branch |
| Bad commit message | Amend: `git commit --amend -m "new message"` |
| Pushed wrong commit | `git revert <commit>` (don't force push) |
| Need to undo commits | `git reset --soft HEAD~N` (before push) |
| Commitlint fails | Fix message format: `<type>: <description>` |

---

## References

- **Commit Convention**: Conventional Commits (https://www.conventionalcommits.org/)
- **Commitlint Config**: `commitlint.config.cjs`
- **Husky Hooks**: `.husky/commit-msg`
- **GitHub CLI**: https://cli.github.com/

---
