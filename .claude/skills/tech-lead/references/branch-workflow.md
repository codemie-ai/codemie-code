# Git Branch Workflow

## Important: Branch and Worktree Creation

**Do NOT create branches or worktrees manually.** The `superpowers:using-git-worktrees` skill handles all branch and worktree setup. Invoke it with the determined branch name (Phase 1 Step 3 in `tech-lead`). All work documented below assumes you are already inside the worktree.

## Branch Naming Convention

### Standard Format

**Jira ticket:** Use the ticket ID exactly as it appears — `EPMCDME-XXXXX`. No prefixes, no suffixes, exact case.

**Free-form task:** Use `feature/descriptive-name` or `task/descriptive-name` in kebab-case. Confirm with user before proceeding.

**Rules:**
- Jira tickets: uppercase EPMCDME, exact ID, nothing else
- Free-form: `feature/` or `task/` prefix, kebab-case description
- Never mix tickets — one branch per ticket

## Making Commits

Follow Conventional Commits format:

```bash
git add path/to/changed/files
git commit -m "feat(scope): description"
```

**For Jira tickets, reference the ticket:**
```bash
git commit -m "feat(agents): add logging to user endpoint

EPMCDME-10500"
```

**Commit types:** `feat`, `fix`, `refactor`, `test`, `docs`, `chore`

## Keeping Branch Updated

Regularly rebase onto main to avoid drift:

```bash
# Rebase onto latest main (preferred — clean history)
git fetch origin
git rebase origin/main

# If conflicts arise, resolve then continue:
# 1. Fix conflicting files
# 2. git add <resolved-files>
# 3. git rebase --continue

# Push rebased branch
git push --force-with-lease origin <branch-name>
```

## Pushing Changes

```bash
# Subsequent pushes
git push

# After rebase (requires force push)
git push --force-with-lease origin <branch-name>
```

## Pre-Merge Checklist

Before creating a merge request:

```bash
# 1. Ensure all changes committed
git status
# Should show: "nothing to commit, working tree clean"

# 2. Sync with latest main
git fetch origin
git rebase origin/main

# 3. Run linting
npm run lint

# 4. Run tests (only if user explicitly requested)
npm test

# 5. Verify no debug code
git diff origin/main --name-only | xargs grep -l "TODO\|FIXME\|console.log\|debugger" || true

# 6. Push final changes
git push --force-with-lease origin <branch-name>
```

## Creating Merge Request

After implementation is complete:

```bash
gh pr create --title "<type>(scope): description" --body "$(cat <<'EOF'
## Summary
- <change 1>
- <change 2>
- <change 3>

## Test Plan
- [ ] Unit tests pass
- [ ] Manual testing completed
- [ ] Linting passes

## Related
- Jira: EPMCDME-XXXXX

🤖 Generated with Claude Code
EOF
)"
```

## Branch Cleanup

After merge:

```bash
# Switch back to main
git checkout main

# Pull merged changes
git pull origin main

# Delete local branch
git branch -d <branch-name>

# Delete remote branch (usually auto-deleted)
git push origin --delete <branch-name>

# Prune deleted remote branches
git fetch --prune
```

## Best Practices

### Do's
✅ Use `superpowers:using-git-worktrees` to create branches and worktrees
✅ Keep branch focused on single ticket
✅ Commit frequently with clear Conventional Commit messages
✅ Sync with main regularly via rebase
✅ Run linting before pushing
✅ Clean up branches after merge

### Don'ts
❌ Don't create branches manually with `git checkout -b`
❌ Don't work directly on main
❌ Don't mix multiple tickets in one branch
❌ Don't force push without `--force-with-lease`
❌ Don't leave branches unmerged for weeks
