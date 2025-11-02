# Git Workflow Policy

This document defines the git workflow standards for the codemie-tools repository.

## Core Principles

**IMPORTANT - Always use feature branches:**
- NEVER commit directly to `main` branch
- ALWAYS create a feature branch for changes
- ALL changes must go through Pull Request review
- Keep branches focused on a single feature or fix

## Branch Naming Conventions

Use descriptive, lowercase branch names with hyphens:

### Patterns

- `feature/add-something` - New features or enhancements
- `fix/issue-description` - Bug fixes
- `docs/update-readme` - Documentation changes
- `refactor/component-name` - Code refactoring without behavior change
- `chore/update-dependencies` - Maintenance tasks (dependencies, config, etc.)
- `test/add-tests` - Adding or updating tests

### Guidelines

- Use lowercase with hyphens (kebab-case)
- Be descriptive but concise
- Include ticket/issue number if applicable:
  - `feature/GH-123-add-jira-integration`
  - `fix/JIRA-456-auth-timeout`
- Keep branch names under 50 characters when possible
- Avoid special characters except hyphens

### Examples

✅ **Good:**
- `feature/add-slack-notifications`
- `fix/memory-leak-in-parser`
- `docs/update-api-guide`
- `refactor/simplify-error-handling`
- `chore/bump-dependencies`

❌ **Bad:**
- `my-branch` (not descriptive)
- `Feature_Add_Something` (wrong case, underscores)
- `fix` (too vague)
- `johns-work` (not task-focused)

## Standard Workflow

### 1. Start from Main

Always start from the latest `main` branch:

```bash
git checkout main
git pull origin main
```

### 2. Create Feature Branch

Create a descriptive feature branch:

```bash
git checkout -b feature/your-feature-name
```

### 3. Make Changes

Work on your changes, committing regularly:

```bash
# Stage changes
git add <files>

# Or stage all changes
git add .

# Commit with descriptive message
git commit -m "type: description"
```

### 4. Push Branch

Push your feature branch to remote:

```bash
# First push (set upstream)
git push -u origin feature/your-feature-name

# Subsequent pushes
git push
```

### 5. Create Pull Request

Create a PR using GitHub UI or CLI:

```bash
# Using GitHub CLI
gh pr create --title "Add feature XYZ" --body "Description of changes"

# Or use GitHub web interface
```

### 6. After PR Approval

Once approved and CI passes, merge the PR:
- Use GitHub's "Squash and merge" for clean history
- Delete the feature branch after merge

## Commit Message Guidelines

Follow [Conventional Commits](https://www.conventionalcommits.org/) specification:

### Format

```
type: short description (72 chars max)

Optional longer description explaining the change.
Can span multiple lines.

Fixes #123
Co-authored-by: CodeMie AI <codemie.ai@gmail.com>
```

### Co-Author Attribution

**When work is assisted by CodeMie AI**, add the co-author line at the end of the commit message:

```
Co-authored-by: CodeMie AI <codemie.ai@gmail.com>
```

This ensures:
- GitHub properly recognizes CodeMie AI contributions
- Contribution graphs show AI-assisted commits
- Clear attribution for AI-generated or AI-assisted code

**Usage:**
```bash
# Single line commit with co-author
git commit -m "feat: add feature" -m "Co-authored-by: CodeMie AI <codemie.ai@gmail.com>"

# Or using heredoc for multi-line
git commit -m "$(cat <<EOF
feat: add new feature

Detailed description of the changes made.

Co-authored-by: CodeMie AI <codemie.ai@gmail.com>
EOF
)"
```

**How GitHub displays co-authors:**
- Appears in commit details on GitHub UI
- Shows in contribution graphs
- Listed in repository insights
- Appears in PR commit lists
- Format must be exact: `Co-authored-by: Name <email@domain.com>`

**Benefits:**
- Clear visibility of AI-assisted work
- Proper attribution in open source contributions
- Transparent collaboration tracking
- Organization-wide AI contribution metrics

### Types

- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation only
- `refactor:` - Code refactoring (no behavior change)
- `test:` - Adding or updating tests
- `chore:` - Maintenance (dependencies, config, build)
- `style:` - Code style changes (formatting, whitespace)
- `perf:` - Performance improvements
- `ci:` - CI/CD changes

### Examples

✅ **Good commit messages:**
```
feat: add Slack notification integration

Implements Slack webhook support for sending notifications
when tickets are created or updated.

Closes #234
Co-authored-by: CodeMie AI <codemie.ai@gmail.com>
```

```
fix: resolve memory leak in report parser

The parser was not releasing file handles after processing.
Added proper cleanup in finally block.

Fixes #456
Co-authored-by: CodeMie AI <codemie.ai@gmail.com>
```

```
docs: update installation guide with Poetry commands

Added missing steps for virtual environment setup
and dependency installation using Poetry.

Co-authored-by: CodeMie AI <codemie.ai@gmail.com>
```

```
refactor: simplify error handling in ITSM toolkit

Consolidated duplicate error handling code into base class.
No functional changes.

Co-authored-by: CodeMie AI <codemie.ai@gmail.com>
```

❌ **Bad commit messages:**
```
Update files          # Too vague
Fixed stuff           # Not descriptive
WIP                   # Work in progress, don't commit
test commit           # Not meaningful
asdfasdf              # Nonsense
```

### Commit Message Best Practices

- **First line**: Concise summary (≤72 characters)
- **Type prefix**: Always use conventional commit type
- **Imperative mood**: "add" not "added" or "adds"
- **Lowercase**: Start description with lowercase
- **No period**: Don't end summary with period
- **Body**: Add context if needed (blank line after summary)
- **References**: Link to issues/PRs when applicable
- **Breaking changes**: Use `!` after type or `BREAKING CHANGE:` in body

## Pull Request Guidelines

### PR Title

Use the same format as commit messages:
```
feat: add feature name
fix: resolve bug description
```

### PR Description Template

```markdown
## Summary
Brief description of changes

## Changes Made
- Bullet point list
- Of specific changes
- In this PR

## Testing
- [ ] Manual testing performed
- [ ] Existing tests pass
- [ ] New tests added (if applicable)

## Screenshots (if applicable)
Add screenshots or GIFs

## Related Issues
Closes #123
Relates to #456

## Checklist
- [ ] Code follows project style guidelines
- [ ] Documentation updated (if needed)
- [ ] Tests added/updated (if needed)
- [ ] All CI checks passing
```

### Review Process

1. **Self-review**: Review your own changes before requesting review
2. **Request review**: Assign relevant reviewers
3. **Address feedback**: Respond to all comments
4. **Keep updated**: Merge main into your branch if conflicts arise
5. **Clean history**: Squash unnecessary commits if needed

## Working with Main Branch

### Keeping Branch Updated

If `main` has moved ahead while working on your feature:

```bash
# From your feature branch
git fetch origin
git merge origin/main

# Or use rebase for cleaner history
git fetch origin
git rebase origin/main
```

### Handling Merge Conflicts

If conflicts occur:

```bash
# 1. Identify conflicted files
git status

# 2. Edit files to resolve conflicts
# Look for <<<<<<, ======, >>>>>> markers

# 3. Mark conflicts as resolved
git add <resolved-files>

# 4. Continue merge/rebase
git merge --continue
# or
git rebase --continue
```

## Emergency Hotfixes

For critical production issues:

```bash
# 1. Create hotfix branch from main
git checkout main
git pull origin main
git checkout -b fix/critical-bug-name

# 2. Make fix and test thoroughly

# 3. Push and create PR
git push -u origin fix/critical-bug-name

# 4. Request expedited review
# Tag PR with "urgent" or "hotfix" label

# 5. Merge after approval (may skip some CI checks if critical)
```

## Best Practices

### Do's ✅

- **Do** create small, focused branches
- **Do** commit frequently with clear messages
- **Do** keep commits atomic (one logical change per commit)
- **Do** write descriptive PR descriptions
- **Do** respond to review feedback promptly
- **Do** update documentation with code changes
- **Do** delete branches after merging
- **Do** test thoroughly before pushing

### Don'ts ❌

- **Don't** commit directly to `main`
- **Don't** push broken code
- **Don't** commit secrets or sensitive data
- **Don't** mix unrelated changes in one commit
- **Don't** use vague commit messages
- **Don't** leave branches stale for weeks
- **Don't** force push to shared branches
- **Don't** commit merge conflicts

## Git Commands Reference

### Essential Commands

```bash
# Check status
git status

# View changes
git diff                    # Unstaged changes
git diff --staged          # Staged changes

# Create branch
git checkout -b branch-name

# Switch branches
git checkout branch-name

# Stage changes
git add <file>
git add .                  # All changes

# Commit
git commit -m "message"
git commit --amend         # Amend last commit

# Push
git push
git push -u origin branch  # First push with upstream

# Pull latest changes
git pull origin main

# View commit history
git log
git log --oneline
git log --graph

# Undo changes
git checkout -- <file>     # Discard unstaged changes
git reset HEAD <file>      # Unstage changes
git reset --soft HEAD~1    # Undo last commit (keep changes)

# Branch management
git branch                 # List branches
git branch -d branch-name  # Delete local branch
git push origin --delete branch-name  # Delete remote branch
```

## Integration with CI/CD

All branches automatically trigger:
- Linting checks
- Unit tests
- Build verification
- Code quality checks

PRs cannot be merged until:
- All CI checks pass
- At least one approval received
- No merge conflicts
- Branch is up to date with main

## Troubleshooting

### "Branch is behind main"

```bash
git fetch origin
git merge origin/main
git push
```

### "Merge conflicts"

```bash
# See conflicted files
git status

# After resolving conflicts
git add <resolved-files>
git commit
```

### "Accidentally committed to main"

```bash
# Create branch from current state
git branch feature/my-changes

# Reset main to match remote
git reset --hard origin/main

# Switch to new branch
git checkout feature/my-changes

# Push branch
git push -u origin feature/my-changes
```

### "Need to update commit message"

```bash
# Last commit only
git commit --amend -m "new message"

# Push (requires force if already pushed)
git push --force-with-lease
```

## Additional Resources

- [Conventional Commits](https://www.conventionalcommits.org/)
- [Git Best Practices](https://git-scm.com/book/en/v2)
- [GitHub Flow](https://guides.github.com/introduction/flow/)
- [Semantic Versioning](https://semver.org/)

---

**Remember**: Following these guidelines ensures clean git history, easier code review, and better collaboration across the team.
