---
name: mr
description: Push the current branch to origin remote and create a pull request to main/master. Intelligently handles merged/closed PRs by creating new branches based on actual changes. Detects and groups commits by theme to create focused PRs. Invokable with /mr.

# Allowed Tools
allowed-tools:
  - "Bash(git*)"
  - "Bash(gh*)"
  - "Bash(jq*)"
  - "Bash(test*)"
  - "Bash([*)"
  - "Bash(wc*)"
  - "Bash(tr*)"
  - "Bash(echo*)"
  - "AskUserQuestion"

# Hooks
hooks:
  Stop:
    - type: command
      command: |
        #!/bin/bash
        # Verify PR was created or branch was pushed
        if [ -n "$PR_URL" ]; then
          echo "✓ PR created: $PR_URL"
          exit 0
        elif [ -n "$BRANCH_PUSHED" ]; then
          echo "✓ Branch pushed: $BRANCH_PUSHED"
          exit 0
        else
          echo "❌ No PR created or branch pushed"
          exit 2
        fi
      timeout: 5
---

# /mr - Merge Request Creation Skill

## Overview

This skill automates the process of creating pull requests from the current branch to main/master. It intelligently handles scenarios where the current branch already has a merged or closed PR by creating a new branch with a descriptive name based on the actual changes.

**Theme-based PR creation:** When your branch contains multiple unrelated commits, `/mr` detects thematic groups and lets you create separate focused PRs via cherry-picking. This improves code review quality by separating concerns (e.g., feature work vs. dependency updates).

## Quick Start

```bash
# Simple workflow
/mr  # Creates or updates PR automatically

# After making changes
# ... make changes ...
git add .
git commit -m "feat: add new feature"
/mr  # Creates PR with conventional commit message

# Theme-based PRs
# (Branch with 4+ unrelated commits)
/mr
# → Skill detects themes
# → You select which themes to create PRs for
# → Skill creates separate themed PRs via cherry-pick
```

## Current Context (Dynamic)

**Branch:** !`git branch --show-current`

**Uncommitted changes:** !`git status --short | wc -l | tr -d ' '` files

**Commits ahead of main:** !`git rev-list --count origin/main..HEAD 2>/dev/null || echo "0"`

**Open PR:** !`gh pr view --json number,state --jq '"#" + (.number | tostring) + " (" + .state + ")"' 2>/dev/null || echo "None"`

## Core Workflow

### Step 1: Check for Uncommitted Changes

```bash
git status
```

**If uncommitted changes exist:**
- Analyze the changes (files modified, new files)
- Generate descriptive branch name based on changes
- Create new branch with generated name
- Stage relevant files with `git add`
- Create commit with conventional commit message

**If no uncommitted changes:**
- Use current branch as-is
- Continue to Step 2

### Step 2: Get Current Branch Name

```bash
BRANCH_NAME=$(git branch --show-current)
```

Store branch name for later PR operations.

### Step 2.5: Detect Themes (Multi-Commit Branches Only)

**Skip if:**
- Only 1 commit on branch
- All commits highly similar (>0.7 similarity)
- Uncommitted changes just committed in Step 1

**Process:**
1. Extract commit data (titles, files, categories)
2. Calculate pairwise similarity (keywords 50%, directories 30%, categories 20%)
3. Cluster commits with similarity ≥0.40
4. Generate theme-based branch names
5. Present themes to user

### Step 2.6: User Interaction - Select Themes

**Use AskUserQuestion** to present theme selection (multi-select):

Options:
- Individual themes (e.g., "feature/commit-skill (2 commits)")
- "All commits (original behavior)"

**User choice handling:**
- "All commits" → Skip to Step 5 (standard workflow)
- One or more themes → Skip to Step 5.5 (cherry-pick workflow)
- No selection → Exit

### Step 3: Check if PR Exists (With Merged/Closed Detection)

**CRITICAL: This step includes the bug fix for merged PR detection**

```bash
# Check if PR exists and get its state
PR_DATA=$(gh pr list --head "$BRANCH_NAME" --json number,title,state,mergedAt,body --jq '.[0]')

if [ -z "$PR_DATA" ] || [ "$PR_DATA" = "null" ]; then
  # Case 1: No PR exists
  echo "ℹ️  No existing PR found for branch: $BRANCH_NAME"
  echo "→ Will create new PR"
  # Continue to Step 5 (push and create PR)
else
  # PR exists - extract state and mergedAt
  PR_NUMBER=$(echo "$PR_DATA" | jq -r '.number')
  PR_STATE=$(echo "$PR_DATA" | jq -r '.state')
  PR_MERGED_AT=$(echo "$PR_DATA" | jq -r '.mergedAt')
  PR_TITLE=$(echo "$PR_DATA" | jq -r '.title')
  PR_BODY=$(echo "$PR_DATA" | jq -r '.body')

  # Check if merged or closed
  if [ -n "$PR_MERGED_AT" ] && [ "$PR_MERGED_AT" != "null" ]; then
    # Case 2: PR is MERGED
    echo "✓ Previous PR #$PR_NUMBER was merged"
    echo "  Title: $PR_TITLE"
    echo "  Merged: $PR_MERGED_AT"
    echo "→ Creating new branch for fresh PR"
    FORCE_NEW_PR=true  # Flag to ensure PR creation after push
    # Continue to Step 4 (create new branch)
  elif [ "$PR_STATE" = "CLOSED" ]; then
    # Case 2: PR is CLOSED (but not merged)
    echo "✓ Previous PR #$PR_NUMBER was closed"
    echo "  Title: $PR_TITLE"
    echo "→ Creating new branch for fresh PR"
    FORCE_NEW_PR=true  # Flag to ensure PR creation after push
    # Continue to Step 4 (create new branch)
  elif [ "$PR_STATE" = "OPEN" ]; then
    # Case 3: PR is OPEN - analyze theme similarity
    echo "ℹ️  PR #$PR_NUMBER is currently open"
    echo "  Title: $PR_TITLE"

    # Step 3.5 & 3.6: Extract PR theme and compare
    if [ "$FORCE_NEW_PR" != "true" ]; then
      # Extract PR theme and compare with new commits
      # Similarity thresholds: ≥0.60 (update), 0.40-0.59 (ask), <0.40 (new PR)

      # Based on similarity, set action:
      # - High match (≥0.60): Continue to Step 5 (update PR)
      # - Borderline (0.40-0.59): Ask user via AskUserQuestion
      # - Low match (<0.40): Continue to Step 4 (new branch)
    fi
  fi
fi
```

**Decision tree summary:**
```
No PR → Create new PR (Step 5)
PR MERGED/CLOSED → Create new branch + PR (Step 4)
PR OPEN → Analyze theme:
  ├─ Similarity ≥0.60 → Update PR (Step 5)
  ├─ Similarity 0.40-0.59 → Ask user
  └─ Similarity <0.40 → Create new PR (Step 4)
```

### Step 4: Create New Branch (Theme-Aware)

**Branch naming priority:**

1. **Theme-based** (if theme detected)
   - Format: `<type>/<subject>`
   - Example: `feature/commit-skill`

2. **Semantic** (fallback)
   - Generated from file changes
   - Example: `feature/week5-content`

**Create branch:**

```bash
git checkout -b <new-branch-name>
```

**Handle collisions:** Add numeric suffix (-2, -3, etc.) if branch exists

**Commit changes if uncommitted:**

```bash
git add <relevant-files>
git commit -m "<conventional-commit-message>"
```

### Step 5: Push to Remote

**CRITICAL: This step includes flow control for FORCE_NEW_PR flag**

```bash
git push -u origin <branch-name>

# Export branch name for stop hook validation
export BRANCH_PUSHED="<branch-name>"
```

**Flow Control:**

```bash
# After push completes successfully
if [ "$FORCE_NEW_PR" = "true" ]; then
  echo ""
  echo "→ Proceeding to Step 6 (Create Pull Request)"
  # Continue to Step 6
fi
```

**Note:** If theme-based splitting is active (from Step 2.6):
- Skip this step and use Step 5.5 instead

### Step 5.5: Cherry-Pick Workflow (Theme-Based PRs)

**Runs when:** User selected specific themes in Step 2.6

**For each selected theme:**

```bash
# 1. Return to main
git checkout main

# 2. Pull latest
git pull origin main

# 3. Create theme branch from main
git checkout -b <theme-branch-name>

# 4. Cherry-pick theme commits (in chronological order)
git cherry-pick <commit-hash>...

# 5. Handle conflicts per strategy
# [Conflict resolution if needed]

# 6. Push theme branch
git push -u origin <theme-branch-name>
export BRANCH_PUSHED="<theme-branch-name>"

# 7. Create PR with theme-specific description
THEME_PR_URL=$(gh pr create --title "<theme-title>" --body "<theme-body>" --base main)
export PR_URL="$THEME_PR_URL"  # Export last PR for stop hook
```

**Conflict handling strategies:**
- `auto_resolve_simple` (recommended) - Auto-resolve one-sided conflicts
- `always_ask` - Interactive for all conflicts
- `abort_on_conflict` - Skip theme on conflict

### Step 6: Create Pull Request

```bash
# Create PR and capture URL
PR_URL=$(gh pr create --title "<title>" --body "<body>" --base main)

# Export PR URL for stop hook validation
export PR_URL
```

**PR Title:**
- Generated from commits (conventional commit style preferred)

**PR Body Sections:**
- Summary
- Changes by Category
- Test Plan
- Impact
- Footer: "🤖 Generated with CodeMie CLI"

### Step 7: Report Results

**Single PR:**

```
✓ Pull Request Created: #<number>

**URL:** <pr-url>
**Branch:** <branch-name> → main
**Status:** <open/updated>
```

**Theme-based PRs:**

```
✓ Theme-based PRs created:

Theme 1: <name>
├─ Branch: <branch-name>
├─ Commits: <hashes>
├─ PR: #<number>
└─ URL: <pr-url>

[Additional themes...]

⚠️  Original branch: <branch-name>
[Cleanup prompt via AskUserQuestion]
```

## Best Practices

1. **Use conventional commits** - Ensures clear commit history
2. **Run /mr frequently** - Keep PRs small and focused
3. **Review theme suggestions** - Ensure meaningful separation
4. **Keep original branch if themes aborted** - For manual resolution
5. **Configure conflict strategy** - Choose based on workflow needs

## Repository Settings

- **Default remote:** origin
- **Default target branch:** main (or master if main doesn't exist)
- **Repository:** Current git repository

## Requirements

- Git repository
- `gh` CLI installed and authenticated
- Push access to repository
- PR creation permissions

Check authentication: `gh auth status`

---

**For detailed algorithms, examples, and advanced usage, see the `references/` directory.**
