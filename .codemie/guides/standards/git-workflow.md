# Git Workflow

## Quick Summary

Git workflow for CodeMie Code: branching strategy, conventional commits, pull requests, and CI enforcement.

**Category**: Standards
**Complexity**: Simple
**Prerequisites**: Git basics, GitHub

---

## Branching Strategy

| Branch Type | Pattern | Purpose | Protected |
|-------------|---------|---------|-----------|
| **Main** | `main` | Production-ready code | Yes (CI required) |
| **Feature** | `feature/[description]` | New features | No |
| **Bugfix** | `fix/[description]` | Bug fixes | No |
| **Refactor** | `refactor/[description]` | Code restructuring | No |
| **Docs** | `docs/[description]` | Documentation | No |
| **Chore** | `chore/[description]` | Maintenance | No |

**Current Example**: `hooks` branch (feature/hooks-based system)

**Base Branch**: Always branch from `main`

---

## Standard Workflow

```bash
# 1. Create feature branch from main
git checkout main
git pull origin main
git checkout -b feature/add-gemini-hooks

# 2. Work and commit (conventional commits)
git add src/agents/core/hooks.ts
git commit -m "feat(agents): add hook-based message system"

# 3. Push to remote
git push origin feature/add-gemini-hooks

# 4. Create PR (via GitHub UI or gh CLI)
gh pr create --title "feat(agents): add hook-based message system" --body "..."

# 5. After approval, merge and cleanup
git checkout main
git pull origin main
git branch -d feature/add-gemini-hooks
```

---

## Commit Format (Conventional Commits)

### Format

```
<type>(<scope>): <subject>

[optional body]

[optional footer]
```

### Types

| Type | When | Example |
|------|------|---------|
| `feat` | New feature | `feat(agents): add gemini plugin support` |
| `fix` | Bug fix | `fix(agents): import CodeMieProxy as value not type` |
| `refactor` | Code restructuring (no behavior change) | `refactor(agents): migrate to hook-based system` |
| `test` | Add/update tests | `test(agents): expand conversation sync tests` |
| `docs` | Documentation only | `docs: update CLAUDE.md with new patterns` |
| `chore` | Maintenance, deps, config | `chore: update dependencies` |
| `perf` | Performance improvement | `perf(exec): optimize command execution` |
| `ci` | CI/CD changes | `ci: add secrets detection workflow` |
| `style` | Formatting only (no logic change) | `style: fix indentation` |
| `build` | Build system changes | `build: update tsconfig target` |

### Scopes

Common scopes in CodeMie Code:
- `agents` - Agent system changes
- `providers` - Provider plugins
- `cli` - CLI commands
- `utils` - Utility functions
- `workflows` - CI/CD workflows
- `tests` - Test infrastructure

### Examples (from recent commits)

```bash
# Recent real commits
git log --oneline -5

# c3e1961 fix(agents): import CodeMieProxy as value not type
# f6c77ba refactor(agents): migrate to hook-based system for messages and analytics
# e66509f refactor(agents): remove redundant sessionId extraction and improve logging
# c52a663 test(agents): expand conversation sync tests with comprehensive coverage
# 4810e6d refactor(agents): separate session infrastructure from metrics code
```

---

## Commit Rules

| ✅ DO | ❌ DON'T |
|-------|----------|
| Atomic commits (one logical change) | Mix unrelated changes |
| Descriptive subject (50 chars) | Vague: "fix stuff", "updates" |
| Present tense ("add", "fix") | Past tense ("added", "fixed") |
| Lowercase subject | Capitalized subject |
| No period at end | "feat: add feature." |
| Reference issues in footer | Skip context |
| Use conventional commit format | Freestyle messages |

**Validation**: Commitlint enforces format (runs on pre-commit and CI)

**Source**: commitlint.config.cjs, .github/workflows/ci.yml:33-37

---

## Pull Request Workflow

### PR Title

**Must follow conventional commit format** (validated in CI):

```
feat(agents): add hook-based message system
fix(cli): handle missing config gracefully
refactor(utils): consolidate path utilities
```

**Source**: .github/workflows/ci.yml:36-37

### PR Description Template

```markdown
## Summary
Brief description of what this PR does and why.

## Changes
- Added hook-based message system for agents
- Migrated Claude and Gemini plugins to use hooks
- Updated tests to cover new hook lifecycle

## Testing
- [x] Unit tests added/updated
- [x] Integration tests pass
- [x] Manual testing completed

## Checklist
- [x] Code follows project standards
- [x] Conventional commit messages
- [x] No secrets in code
- [x] CI checks pass
- [x] Documentation updated (if needed)
```

### PR Labels

| Label | Purpose |
|-------|---------|
| `feature` | New functionality |
| `bugfix` | Bug fixes |
| `refactor` | Code restructuring |
| `documentation` | Docs updates |
| `breaking-change` | Breaking API changes |

---

## CI Checks (Required for Merge)

### Validation Stage (Parallel)

| Check | Purpose | Runs On |
|-------|---------|---------|
| **Commit Messages** | Conventional commits format | PRs only |
| **PR Title** | Conventional commits format | PRs only |
| **Secrets Detection** | Gitleaks scan | PRs only |

### Build & Test Stage (Sequential)

| Stage | Commands | Timeout |
|-------|----------|---------|
| **License Check** | `npm run license-check` | 5 min |
| **Lint** | `npm run lint` (max-warnings=0) | 5 min |
| **Build** | `npm run build` | 10 min |
| **Unit Tests** | `npm run test:unit` | 10 min |
| **Integration Tests** | `npm run test:integration` | 15 min |

**Source**: .github/workflows/ci.yml:1-200+

**All checks must pass** before merge is allowed.

---

## Code Review Guidelines

### Reviewer Checklist

- [ ] Code follows project standards (ESLint, naming conventions)
- [ ] Logic is correct and handles edge cases
- [ ] Tests are comprehensive (unit + integration)
- [ ] No security vulnerabilities (secrets, injection, path traversal)
- [ ] Error handling is robust
- [ ] Performance implications considered
- [ ] Documentation updated (if public API changed)
- [ ] No breaking changes (or clearly marked)
- [ ] Commit messages follow conventional commits

### Review Focus Areas

| Priority | Focus |
|----------|-------|
| **High** | Security, correctness, breaking changes |
| **Medium** | Performance, test coverage, error handling |
| **Low** | Style, naming, minor refactoring |

---

## Merge Strategy

**Standard**: Merge commit (preserves commit history)

```bash
# Merge button in GitHub UI
# Or via CLI:
gh pr merge 123 --merge
```

**NOT used**: Squash or rebase (we preserve full commit history)

**After Merge**:
```bash
# Update local main
git checkout main
git pull origin main

# Delete merged branch
git branch -d feature/add-gemini-hooks
git push origin --delete feature/add-gemini-hooks
```

---

## Protected Branch Rules

**Main Branch**:
- ✅ Require pull request before merging
- ✅ Require status checks to pass (CI)
- ✅ Require conversation resolution
- ❌ No direct pushes allowed
- ❌ No force push allowed

---

## Common Git Commands

### Everyday Commands

```bash
# Check status
git status

# Stage files
git add src/agents/core/hooks.ts
git add .  # Stage all

# Commit
git commit -m "feat(agents): add hooks system"

# Push
git push origin feature/my-feature

# Pull latest
git pull origin main

# View recent commits
git log --oneline -10

# View changes
git diff
git diff --staged  # View staged changes
```

### Branch Management

```bash
# Create and switch
git checkout -b feature/new-feature

# Switch branches
git checkout main
git checkout feature/existing-feature

# List branches
git branch        # Local
git branch -a     # All (including remote)

# Delete branch
git branch -d feature/merged-feature  # Safe delete
git branch -D feature/force-delete    # Force delete

# Rename branch
git branch -m old-name new-name
```

### Fixing Mistakes

```bash
# Undo last commit (keep changes)
git reset --soft HEAD~1

# Undo last commit (discard changes) - CAREFUL!
git reset --hard HEAD~1

# Amend last commit message
git commit --amend -m "fix(agents): corrected typo"

# Discard unstaged changes
git restore src/agents/core/hooks.ts

# Unstage file
git restore --staged src/agents/core/hooks.ts
```

---

## Pre-Commit Hooks (Automated)

**Setup**: Husky + lint-staged (installed via `npm run prepare`)

**Runs on every commit**:
1. ESLint on staged `.ts` files (zero warnings required)
2. Vitest on related tests
3. License check (if package.json changed)
4. Commitlint (validates commit message format)

**Source**: package.json:45-52, .husky/pre-commit

**Bypass** (not recommended):
```bash
git commit --no-verify -m "message"  # Skip hooks
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Commit rejected (format) | Fix message format: `type(scope): subject` |
| Commit rejected (secrets) | Remove secrets, use env vars or config |
| CI failing on lint | Run `npm run lint:fix` locally |
| CI failing on tests | Run `npm test` locally, fix failures |
| Merge conflicts | `git pull origin main`, resolve conflicts, commit |
| Can't push (protected) | Create PR instead of pushing to main |
| Pre-commit hook slow | Normal (runs lint + tests on changed files) |

---

## Best Practices

| ✅ DO | ❌ DON'T |
|-------|----------|
| Commit frequently (atomic changes) | One giant commit |
| Write descriptive commit messages | "wip", "fixes", "updates" |
| Pull main before creating branch | Branch from stale main |
| Test locally before pushing | Push broken code |
| Resolve conflicts promptly | Let conflicts pile up |
| Delete merged branches | Leave stale branches |
| Use conventional commits | Freestyle commit messages |
| Request reviews promptly | Let PRs go stale |

---

## References

- **CI Workflow**: `.github/workflows/ci.yml`
- **Commitlint Config**: `commitlint.config.cjs`
- **Pre-commit Hooks**: `.husky/pre-commit`, `package.json` (lint-staged)
- **Conventional Commits**: https://www.conventionalcommits.org
- **GitHub Flow**: https://docs.github.com/en/get-started/quickstart/github-flow

---

## Related Guides

- Code Quality: .codemie/guides/standards/code-quality.md
- Testing Patterns: .codemie/guides/testing/testing-patterns.md
- Development Practices: .codemie/guides/development/development-practices.md
