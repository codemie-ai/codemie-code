# Git Branch Workflow for Jira Tickets

## Purpose

This guide defines the git branching workflow specifically for Jira ticket implementation in the Codemie project. It ensures consistent branch naming, proper isolation, and smooth integration.

## Branch Naming Convention

### Standard Format

```
EPMCDME-XXXXX
```

**Rules:**
- Use ticket ID exactly as it appears in Jira
- No prefixes (no `feature/`, `bugfix/`, etc.)
- No suffixes or descriptions
- Match case exactly (uppercase EPMCDME)

**Examples:**
```bash
# Correct
git checkout -b EPMCDME-10500
git checkout -b EPMCDME-9876

# Incorrect
git checkout -b feature/EPMCDME-10500  # No prefix
git checkout -b EPMCDME-10500-add-logging  # No suffix
git checkout -b epmcdme-10500  # Wrong case
```

### Why This Format?

1. **Traceability**: Direct link to Jira ticket
2. **Automation**: GitLab/GitHub can auto-link commits to tickets
3. **Simplicity**: No ambiguity in naming
4. **Consistency**: Team-wide standard

## Branch Creation Workflow

### Step 1: Check Current Status

Before creating a branch, verify clean working state:

```bash
# Check current branch
git branch --show-current

# Check for uncommitted changes
git status

# Check for stashed changes
git stash list
```

**If uncommitted changes exist:**
```bash
# Option 1: Commit them
git add .
git commit -m "WIP: Save current work"

# Option 2: Stash them
git stash push -m "WIP before EPMCDME-XXXXX"

# Option 3: Discard them (if safe)
git reset --hard
```

### Step 2: Update Main Branch

Ensure main branch is up to date:

```bash
# Switch to main
git checkout main

# Pull latest changes
git pull origin main

# Verify no conflicts
git status
```

### Step 3: Create Feature Branch

Create branch from updated main:

```bash
# Create and switch to new branch
git checkout -b EPMCDME-XXXXX

# Verify you're on the new branch
git branch --show-current
# Should output: EPMCDME-XXXXX

# Verify branch was created from main
git log --oneline -1
# Should match latest commit on main
```

### Step 4: Push Branch to Remote

Push the new branch to establish remote tracking:

```bash
# Push and set upstream
git push -u origin EPMCDME-XXXXX

# Verify remote tracking
git branch -vv
# Should show: [origin/EPMCDME-XXXXX]
```

## Branch Already Exists

### If Branch Exists Locally

```bash
# Check if branch exists
git branch --list EPMCDME-XXXXX

# If exists, you have options:

# Option 1: Switch to existing branch
git checkout EPMCDME-XXXXX
git pull origin EPMCDME-XXXXX  # Update from remote

# Option 2: Delete and recreate (if safe)
git checkout main
git branch -D EPMCDME-XXXXX  # Force delete
git checkout -b EPMCDME-XXXXX

# Option 3: Create with different name (not recommended)
git checkout -b EPMCDME-XXXXX-v2
```

### If Branch Exists Remotely

```bash
# Check remote branches
git branch -r | grep EPMCDME-XXXXX

# If exists remotely:

# Option 1: Check out remote branch
git fetch origin
git checkout EPMCDME-XXXXX
# Automatically tracks remote branch

# Option 2: Fetch and create local tracking branch
git fetch origin EPMCDME-XXXXX:EPMCDME-XXXXX
git checkout EPMCDME-XXXXX
```

### Conflict Resolution

If local and remote branches diverged:

```bash
# Check divergence
git checkout EPMCDME-XXXXX
git fetch origin
git status
# Will show: "Your branch and 'origin/EPMCDME-XXXXX' have diverged"

# Option 1: Rebase local changes onto remote
git pull --rebase origin EPMCDME-XXXXX

# Option 2: Merge remote changes
git pull origin EPMCDME-XXXXX

# Option 3: Force local to match remote (discard local)
git reset --hard origin/EPMCDME-XXXXX

# Option 4: Force remote to match local (overwrite remote)
git push --force-with-lease origin EPMCDME-XXXXX
```

## Working on the Branch

### Making Commits

Follow commit message conventions:

```bash
# Standard commit
git add path/to/changed/files
git commit -m "EPMCDME-XXXXX: Brief description of change"

# Examples:
git commit -m "EPMCDME-10500: Add logging to user endpoint"
git commit -m "EPMCDME-10500: Implement user validation service"
git commit -m "EPMCDME-10500: Add unit tests for user service"
```

**Commit Message Format:**
```
EPMCDME-XXXXX: <imperative description>

[Optional detailed explanation]
[Optional breaking changes note]

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
```

### Keeping Branch Updated

Regularly sync with main to avoid merge conflicts:

```bash
# Option 1: Rebase (preferred - cleaner history)
git checkout EPMCDME-XXXXX
git fetch origin
git rebase origin/main

# If conflicts, resolve and continue:
# 1. Fix conflicts in files
# 2. git add <resolved-files>
# 3. git rebase --continue

# Option 2: Merge (preserves history)
git checkout EPMCDME-XXXXX
git fetch origin
git merge origin/main

# Push updated branch
git push --force-with-lease origin EPMCDME-XXXXX
```

### Pushing Changes

```bash
# First push (already done in step 4)
git push -u origin EPMCDME-XXXXX

# Subsequent pushes
git push

# After rebase (requires force push)
git push --force-with-lease origin EPMCDME-XXXXX
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
make ruff
# Or: poetry run ruff check --fix && poetry run ruff format

# 4. Run tests
poetry run pytest tests/

# 5. Verify no debug code
git diff origin/main --name-only | xargs grep -l "TODO\|FIXME\|console.log\|breakpoint()"

# 6. Push final changes
git push --force-with-lease origin EPMCDME-XXXXX
```

## Creating Merge Request

After implementation is complete:

```bash
# Create MR using GitLab CLI
gh pr create --title "EPMCDME-XXXXX: <title>" --body "$(cat <<'EOF'
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

Alternatively, use codemie-mr skill:

```bash
# Let skill handle MR creation
Use Skill tool with skill="codemie-mr"
```

## Branch Cleanup

After merge:

```bash
# Switch back to main
git checkout main

# Pull merged changes
git pull origin main

# Delete local branch
git branch -d EPMCDME-XXXXX

# Delete remote branch (usually auto-deleted by GitLab)
git push origin --delete EPMCDME-XXXXX

# Prune deleted remote branches
git fetch --prune
```

## Common Issues and Solutions

### Issue: Forgot to Create Branch

If started work on main by mistake:

```bash
# 1. Create branch from current state
git checkout -b EPMCDME-XXXXX

# 2. Verify changes came with you
git status

# 3. Commit changes
git add .
git commit -m "EPMCDME-XXXXX: <description>"

# 4. Push new branch
git push -u origin EPMCDME-XXXXX

# 5. Reset main to origin
git checkout main
git reset --hard origin/main
```

### Issue: Wrong Branch Name

If created branch with wrong name:

```bash
# Rename local branch
git branch -m old-name EPMCDME-XXXXX

# Delete old remote branch
git push origin --delete old-name

# Push new branch name
git push -u origin EPMCDME-XXXXX
```

### Issue: Committed to Wrong Branch

If committed to wrong branch:

```bash
# 1. Note the commit hash
git log --oneline -1
# Example output: abc1234 EPMCDME-XXXXX: My change

# 2. Switch to correct branch
git checkout EPMCDME-XXXXX

# 3. Cherry-pick the commit
git cherry-pick abc1234

# 4. Switch back to wrong branch
git checkout wrong-branch

# 5. Remove the commit
git reset --hard HEAD~1
```

### Issue: Branch Diverged from Main

If branch has fallen far behind main:

```bash
# Check how far behind
git checkout EPMCDME-XXXXX
git fetch origin
git log --oneline EPMCDME-XXXXX..origin/main

# If many commits behind, rebase
git rebase origin/main

# Resolve conflicts one by one
# After each conflict:
# 1. Fix files
# 2. git add <files>
# 3. git rebase --continue

# Force push rebased branch
git push --force-with-lease origin EPMCDME-XXXXX
```

## Best Practices

### Do's
✅ Always create branch before starting work
✅ Use exact ticket ID as branch name
✅ Keep branch focused on single ticket
✅ Commit frequently with clear messages
✅ Sync with main regularly
✅ Run linting and tests before pushing
✅ Clean up branches after merge

### Don'ts
❌ Don't work directly on main
❌ Don't add prefixes or suffixes to branch name
❌ Don't mix multiple tickets in one branch
❌ Don't force push without --force-with-lease
❌ Don't leave branches unmerged for weeks
❌ Don't commit without ticket reference

## Branch Lifecycle Summary

```
1. Update main
   git checkout main && git pull origin main

2. Create feature branch
   git checkout -b EPMCDME-XXXXX

3. Push branch
   git push -u origin EPMCDME-XXXXX

4. Work and commit
   git add . && git commit -m "EPMCDME-XXXXX: Change"
   git push

5. Keep updated
   git fetch origin && git rebase origin/main
   git push --force-with-lease

6. Create MR
   gh pr create ... or use codemie-mr skill

7. After merge, cleanup
   git checkout main && git pull origin main
   git branch -d EPMCDME-XXXXX
```

## Emergency Procedures

### Accidentally Deleted Work

```bash
# Find lost commits
git reflog

# Restore from reflog
git checkout -b recovery-branch <commit-hash>
```

### Accidentally Pushed to Main

```bash
# If pushed to main (and no one else pulled):
git checkout main
git reset --hard origin/main~1  # Go back 1 commit
git push --force-with-lease origin main

# Create proper branch
git checkout -b EPMCDME-XXXXX
git cherry-pick <commit-hash>  # Get your changes back
```

### Branch Completely Broken

```bash
# Start fresh from main
git checkout main
git pull origin main

# Create new branch
git checkout -b EPMCDME-XXXXX

# Cherry-pick good commits from broken branch
git log broken-branch --oneline
git cherry-pick <good-commit-1>
git cherry-pick <good-commit-2>

# Delete broken branch
git branch -D broken-branch
git push origin --delete broken-branch
```
