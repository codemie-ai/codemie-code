---
name: git-worktree
description: Manages git worktrees including listing, creating, removing, and switching between worktrees. Use when the user mentions creating worktrees, create a work tree, create worktree, new worktrees, parallel branches, or working on multiple branches simultaneously. CRITICAL - PROACTIVE BRANCH PROTECTION - Before starting ANY development work (implementing features, fixing bugs, writing code, making changes), check the current branch. If on main/master branch, IMMEDIATELY suggest creating a feature branch worktree to prevent accidental commits to main. This is mandatory for all development requests.
---

# Git Worktree Management Skill

This skill helps you manage git worktrees efficiently. Git worktrees allow you to check out multiple branches simultaneously in different directories, which is useful for:

- Working on multiple features in parallel
- Testing different branches without losing work-in-progress
- Reviewing code while continuing development
- Quick bug fixes on main while working on a feature branch

## ⚠️ CRITICAL: Proactive Branch Protection Workflow

**MANDATORY RULE**: Before starting ANY development work, always check the current branch to prevent accidental commits to main/master.

### When to Apply This Workflow

Trigger this workflow proactively when the user requests ANY development task:
- Implementing features ("add feature X", "build component Y")
- Fixing bugs ("fix this bug", "resolve the error")
- Writing or modifying code ("update this file", "refactor the code")
- Making changes to the codebase ("change the logic", "improve performance")

### Branch Protection Steps

1. **Check Current Branch**
   ```bash
   git branch --show-current
   ```

2. **If on main/master/develop branch**
   - STOP immediately before making any code changes
   - Inform the user: "⚠️ You're currently on the `[branch-name]` branch. To protect the main branch from accidental commits, I recommend creating a feature branch worktree for this work."
   - Ask: "Would you like me to create a feature branch worktree? (y/n)"

3. **If User Agrees (or automatically proceed)**
   - Ask for branch name if not provided: "What would you like to name the branch? (e.g., feat/add-login, fix/button-crash)"
   - Generate appropriate branch prefix following commitlint conventional commit types:
     - **feat/**: New features (e.g., `feat/user-authentication`)
     - **fix/**: Bug fixes (e.g., `fix/login-error`)
     - **refactor/**: Code refactoring (e.g., `refactor/auth-module`)
     - **perf/**: Performance improvements (e.g., `perf/optimize-queries`)
     - **docs/**: Documentation changes (e.g., `docs/api-guide`)
     - **style/**: Code style/formatting (e.g., `style/eslint-fixes`)
     - **test/**: Adding or updating tests (e.g., `test/auth-coverage`)
     - **chore/**: Maintenance tasks (e.g., `chore/update-deps`)
     - **ci/**: CI/CD changes (e.g., `ci/github-actions`)
     - **build/**: Build system changes (e.g., `build/webpack-config`)
   - Create the worktree using the workflow below
   - Switch to the new worktree
   - Confirm: "✓ Switched to branch worktree at [path]. Ready to proceed with development."

4. **If User Declines**
   - Warn: "⚠️ Proceeding on `[branch-name]` branch. Please be careful with commits."
   - Continue with the requested work

### Quick Worktree Creation Workflow

When creating a feature branch worktree:

```bash
# 1. Get repository name
REPO_NAME=$(basename "$(git rev-parse --show-toplevel)")

# 2. Get and sanitize branch name
BRANCH_NAME="feat/new-feature"  # User provided or generated with commitlint prefix
SANITIZED_BRANCH=$(echo "$BRANCH_NAME" | sed 's/\//-/g')

# 3. Build worktree path
WORKTREE_PATH="../${REPO_NAME}-wt-${SANITIZED_BRANCH}"

# 4. Create worktree with new branch
git worktree add -b "$BRANCH_NAME" "$WORKTREE_PATH" main

# 5. Switch to the worktree
cd "$WORKTREE_PATH"
```

### Example Interaction

**User**: "Let's add a new authentication feature"

**Assistant checks branch**: `git branch --show-current` → returns "main"

**Assistant responds**:
"⚠️ You're currently on the `main` branch. To protect the main branch from accidental commits, I recommend creating a feature branch worktree for this work.

Would you like me to create a feature branch worktree? I can name it `feat/authentication` or you can suggest a different name."

**User**: "Yes, use feat/auth"

**Assistant executes**:
```bash
REPO_NAME=$(basename "$(git rev-parse --show-toplevel)")
BRANCH_NAME="feat/auth"
SANITIZED_BRANCH="feat-auth"
WORKTREE_PATH="../${REPO_NAME}-wt-feat-auth"
git worktree add -b "$BRANCH_NAME" "$WORKTREE_PATH" main
cd "$WORKTREE_PATH"
```

**Assistant confirms**: "✓ Created and switched to feature branch worktree at `../myproject-wt-feat-auth`. Ready to implement the authentication feature."

### Benefits of This Workflow

- **Prevents accidents**: Never commit directly to protected branches
- **Clean history**: Keeps main branch clean and stable
- **Easy collaboration**: Feature branches are standard for PRs
- **Parallel work**: Can still access main branch in original directory
- **Safe experimentation**: Easy to discard or reset feature branch

## Naming Convention

Worktrees should be created as sibling directories with a clear naming pattern:

**Pattern**: `../<repo-name>-wt-<branch-name>`

**Example**: For a repo named "MyProject" with branch "feat/new-login":

```
/Users/username/source/myproject/              # Main repo
/Users/username/source/myproject-wt-feat-new-login/  # Worktree
```

**Note**: Branch names follow commitlint conventional commit types (feat/, fix/, refactor/, etc.)

## Available Operations

### List Worktrees

Show all existing worktrees with their paths and branches:

```bash
git worktree list
```

Example output:

```
/Users/username/source/myproject        c5b174796b4 [main]
/Users/username/source/myproject-wt-feat-auth   def5378 [feat/new-login]
/Users/username/source/myproject-wt-fix-crash   ghi9022 [fix/button-crash]
```

### Create a New Worktree

When creating worktrees, automatically use the naming convention:

**For existing branches:**

```bash
git worktree add ../<repo-name>-wt-<sanitized-branch-name> <branch-name>
```

**For new branches:**

```bash
git worktree add -b <new-branch-name> ../<repo-name>-wt-<sanitized-branch-name> <base-branch>
```

**Note**: Branch names with slashes (e.g., `feature/new-login`) should be sanitized by replacing `/` with `-` for the directory name.

Examples:

```bash
# Checkout existing feature branch
git worktree add ../myproject-wt-feat-auth feat/auth

# Create new feature branch from main
git worktree add -b feat/new-payment ../myproject-wt-feat-new-payment main

# Create bugfix worktree
git worktree add -b fix/critical-bug ../myproject-wt-fix-critical-bug main
```

### Remove a Worktree

When you're done with a worktree:

```bash
# Remove worktree (must not have uncommitted changes)
git worktree remove ../<repo-name>-wt-<branch-name>

# Force remove even with uncommitted changes
git worktree remove --force ../<repo-name>-wt-<branch-name>
```

### Prune Stale Worktrees

Clean up worktree metadata for manually deleted directories:

```bash
git worktree prune
```

### Move a Worktree

Relocate an existing worktree (maintaining naming convention):

```bash
git worktree move <old-path> <new-path>
```

### Lock/Unlock Worktrees

Prevent accidental deletion:

```bash
git worktree lock <path>
git worktree unlock <path>
```

## Helper Functions

When creating worktrees, the skill should:

1. **Get the repository name**: Extract from the current directory name
2. **Sanitize the branch name**: Replace `/` with `-` for the path
3. **Build the path**: `../<repo-name>-wt-<sanitized-branch-name>`

Example logic:

```bash
REPO_NAME=$(basename "$(git rev-parse --show-toplevel)")
BRANCH_NAME="feature/new-login"
SANITIZED_BRANCH=$(echo "$BRANCH_NAME" | sed 's/\//-/g')
WORKTREE_PATH="../${REPO_NAME}-wt-${SANITIZED_BRANCH}"

git worktree add "$WORKTREE_PATH" "$BRANCH_NAME"
```

## Best Practices

1. **Naming Convention**: Always use `<repo-name>-wt-<branch-name>` pattern
2. **Location**: Keep worktrees as siblings to the main repo directory
3. **Cleanup**: Remove worktrees when done to avoid clutter
4. **Branch Tracking**: Each worktree tracks a different branch
5. **Shared Objects**: Worktrees share the same .git repository, saving disk space
6. **Multiple Repos**: The naming convention prevents confusion when multiple repos are in the same parent directory

## Troubleshooting

### Worktree Already Exists

If you get an error that a worktree already exists for a branch, you can:
1. Use `git worktree list` to find where it is
2. Remove the existing worktree first
3. Check out a different branch in the existing worktree

### Locked Worktree

If removal fails due to a lock:

```bash
git worktree unlock <path>
git worktree remove <path>
```

### Stale Worktree References

If worktrees were manually deleted:

```bash
git worktree prune
```

### Branch Name Sanitization

Remember to replace `/` with `-` when creating directory names from branch names like `feature/new-login` → `feature-new-login`.

## Integration with This Skill

### Automatic Triggers

When you ask me to:
- **Start development work** - I'll FIRST check if you're on main/master and suggest a worktree
- "List my worktrees" - I'll run `git worktree list`
- "Create a worktree for feature X" - I'll use the `<repo-name>-wt-X` naming pattern
- "Clean up worktrees" - I'll help remove old ones safely
- "Switch to worktree Y" - I'll navigate to the properly named directory
- "What worktrees exist?" - I'll list and explain them with full paths

### Development Task Examples

**Example 1**: User says "Let's add a login feature"
1. Check branch: `git branch --show-current` → "main"
2. Warn and suggest worktree creation
3. If approved, create `feat/login` worktree
4. Switch to worktree
5. Proceed with implementation

**Example 2**: User says "Fix the broken button"
1. Check branch: `git branch --show-current` → "main"
2. Warn and suggest worktree creation
3. If approved, create `fix/broken-button` worktree
4. Switch to worktree
5. Proceed with fix

**Example 3**: User says "Refactor the authentication module"
1. Check branch: `git branch --show-current` → "feat/dashboard"
2. Already on feature branch, safe to proceed
3. Continue with refactoring

This skill automatically applies the naming convention to keep your workspace organized, especially when managing multiple repositories in the same parent directory. The proactive branch protection ensures you never accidentally commit to protected branches.