# Examples and Integration Reference

## Common Workflows

### Example 1: Simple PR Creation (No Existing PR)

**Scenario:** First PR from a clean branch, no complications

**Starting state:**
```
Branch: feature/commit-skill
Commits: feat: add /commit skill (already committed)
No existing PR
No uncommitted changes
```

**Execution:**

```bash
$ /mr

→ Step 1: Check for uncommitted changes
  ✓ No uncommitted changes

→ Step 2: Get current branch
  Current branch: feature/commit-skill

→ Step 2.5: Detect themes
  ℹ️  Only 1 commit - skipping theme detection

→ Step 3: Check if PR exists
  gh pr list --head feature/commit-skill
  ℹ️  No existing PR found

→ Step 5: Push to remote
  git push -u origin feature/commit-skill
  ✓ Pushed

→ Step 6: Create PR
  gh pr create --title "Add /commit skill for automated commit messages" \
               --body "..."
  ✓ PR #58 created

✓ Pull Request Created: #58
**URL:** https://github.com/org/repo/pull/58
**Branch:** feature/commit-skill → main
**Status:** open
```

### Example 2: Updates to Active PR

**Scenario:** Branch already has an open PR, adding more commits

**Starting state:**
```
Branch: feature/add-charts
PR #55: OPEN
New commits: feat: update chart tooltips (not yet pushed)
```

**Execution:**

```bash
$ /mr

→ Step 1: Check for uncommitted changes
  ✓ No uncommitted changes

→ Step 2: Get current branch
  Current branch: feature/add-charts

→ Step 3: Check if PR exists
  gh pr list --head feature/add-charts
  ✓ PR #55 is OPEN

→ Step 3.5: Extract PR theme
  Analyzing commits in PR #55...
  Keywords: charts, visualization, data
  Dirs: src/, components/

→ Step 3.6: Compare with new commits
  New commit: feat: update chart tooltips
  Keywords: chart, tooltip, visualization
  Dirs: src/

  Theme similarity: 0.78 (High)
  → Updating existing PR #55

→ Step 5: Push to remote
  git push
  ✓ Pushed

✓ Updated existing PR: #55
**URL:** https://github.com/org/repo/pull/55
**Status:** Updated with latest changes
```

### Example 3: Merged PR Detection - Creates New Branch and PR

**Scenario:** Branch has a merged PR, new changes need a new PR

**Starting state:**
```
Branch: feature/week4-integration
PR #50: MERGED (2 days ago)
Modified files: docs/guide.md, .github/workflows/ci.yml
Uncommitted changes: Yes
```

**Execution:**

```bash
$ /mr

→ Step 1: Check for uncommitted changes
  Modified: docs/guide.md
  Modified: .github/workflows/ci.yml

  Analyzing changes...
  Primary: Documentation + workflow fix

→ Step 2: Get current branch
  Current branch: feature/week4-integration

→ Step 3: Check if PR exists
  gh pr list --head feature/week4-integration --json number,state,mergedAt

  ✓ Previous PR #50 was merged
    Title: Add Week 4 integration examples
    Merged: 2025-01-22T14:30:00Z

  → Creating new branch for fresh PR

→ Step 4: Create new branch
  Generating semantic branch name...
  Analysis:
  - Documentation changes
  - Workflow fix
  Type: docs
  Subject: guide-workflow

  git checkout -b docs/guide-workflow
  ✓ Created new branch: docs/guide-workflow

→ Step 4 (continued): Commit changes
  git add docs/guide.md .github/workflows/ci.yml

  git commit -m "docs: update guide and fix workflow permissions"
  ✓ Commit created

→ Step 5: Push to remote
  git push -u origin docs/guide-workflow
  ✓ Pushed

→ Step 6: Create PR
  gh pr create...
  ✓ PR #57 created

✓ Pull Request Created: #57
**URL:** https://github.com/org/repo/pull/57
**Branch:** docs/guide-workflow → main
**Status:** open
**Reason:** Previous PR #50 was merged, created new branch for fresh changes
```

### Example 4: Theme-Based PR Creation (Multi-Commit Branch)

**Scenario:** Branch with 4 commits covering 3 different themes

**Starting state:**
```
Branch: feature/add-commit-skill-clean
Commits:
- feat: add /commit skill
- feat: update /mr skill to use /commit
- chore: update dependencies
- refactor: remove legacy /mr command
No uncommitted changes
```

**Execution:**

```bash
$ /mr

→ Step 1: No uncommitted changes

→ Step 2: Current branch: feature/add-commit-skill-clean

→ Step 2.5: Detect themes
  Analyzing 4 commits...

  Calculating similarities:
  - commit1 ↔ commit2: 0.65 (skills + commit focus)
  - commit1 ↔ commit3: 0.0 (unrelated)
  - commit1 ↔ commit4: 0.12 (low similarity)
  - commit2 ↔ commit3: 0.0 (unrelated)
  - commit2 ↔ commit4: 0.10 (low similarity)
  - commit3 ↔ commit4: 0.0 (unrelated)

  Clustering (threshold 0.40):
  - Theme A: commit1 + commit2 (similarity 0.65)
  - Theme B: commit3 (no connections)
  - Theme C: commit4 (no connections)

  Generating theme names:
  - Theme A: feature/commit-skill (keywords: skill, commit, mr)
  - Theme B: chore/deps-update (keywords: dependencies, update)
  - Theme C: refactor/mr-command (keywords: legacy, mr, command)

✓ Analyzed 4 commits
✓ Identified 3 themes:

Theme 1: "feature/commit-skill" (2 commits)
├─ feat: add /commit skill
└─ feat: update /mr skill to use /commit
Files: .codemie/skills/{commit,mr}/SKILL.md

Theme 2: "chore/deps-update" (1 commit)
└─ chore: update dependencies
Files: package.json, */package-lock.json

Theme 3: "refactor/mr-command" (1 commit)
└─ refactor: remove legacy /mr command
Files: .codemie/commands/mr.md

→ Step 2.6: User interaction
  [AskUserQuestion prompt]
  Which themes should be included in PRs?
  ☑ feature/commit-skill (2 commits)
  ☐ chore/deps-update (1 commit)
  ☑ refactor/mr-command (1 commit)
  ☐ All commits (original behavior)

  User selected: Theme 1 and Theme 3

→ Step 5.5: Cherry-pick workflow

  Creating Theme 1: feature/commit-skill
  → git checkout main
  → git pull origin main
  → git checkout -b feature/commit-skill
  → git cherry-pick <commit1-hash>
    ✓ Applied
  → git cherry-pick <commit2-hash>
    ✓ Applied
  → git push -u origin feature/commit-skill
    ✓ Pushed
  → gh pr create --title "Add /commit skill and update /mr integration"
    ✓ PR #95 created

  Creating Theme 3: refactor/mr-command
  → git checkout main
  → git checkout -b refactor/mr-command
  → git cherry-pick <commit4-hash>
    ✓ Applied
  → git push -u origin refactor/mr-command
    ✓ Pushed
  → gh pr create --title "Remove legacy /mr command"
    ✓ PR #96 created

✓ Theme-based PRs created:

Theme 1: feature/commit-skill
├─ Branch: feature/commit-skill
├─ Commits: 2 commits
├─ PR: #95
└─ URL: https://github.com/org/repo/pull/95

Theme 3: refactor/mr-command
├─ Branch: refactor/mr-command
├─ Commits: 1 commit
├─ PR: #96
└─ URL: https://github.com/org/repo/pull/96

ℹ️  Unselected themes remain on original branch:
    - Theme 2 (deps-update): 1 commit

⚠️  Original branch unchanged: feature/add-commit-skill-clean

→ [AskUserQuestion] What to do with original branch?
  User selects: "Delete it"

→ git branch -D feature/add-commit-skill-clean
  ✓ Deleted

✓ Workflow complete. Created 2 themed PRs from 4 commits.
```

## Typical Usage Patterns

### Pattern 1: Single Feature Branch → Single PR

**Use case:** Working on a focused feature

```bash
git checkout -b feature/add-tooltips
# ... make changes ...
git add src/components/Tooltip.tsx
git commit -m "feat: add tooltip component"
/mr
# → Creates PR #100
```

### Pattern 2: Long-Running Branch → Multiple PRs via Themes

**Use case:** Branch accumulated multiple unrelated commits

```bash
# On branch: feature/misc-work
# Has 5 commits: 3 about features, 2 about infrastructure

/mr
# → Detects themes
# → User selects: "features" and "infra" themes
# → Creates PR #101 (features) and PR #102 (infra)
# → Original branch kept or deleted (user choice)
```

### Pattern 3: Incremental PR Updates

**Use case:** Adding commits to existing PR

```bash
# PR #50 already open for feature/add-charts

# ... make more changes ...
git commit -m "feat: improve chart performance"

/mr
# → Detects open PR #50
# → Theme similarity: High
# → Pushes to existing branch
# → PR #50 updated
```

### Pattern 4: Merged PR → New Work

**Use case:** Previous PR merged, new changes on same branch

```bash
# PR #50 merged yesterday
# Currently on feature/week4-integration

# ... new changes ...
/mr
# → Detects merged PR #50
# → Creates new branch: feature/week5-updates
# → Creates new PR #57
```

## Common Scenarios and Outcomes

| Scenario | PR State | Theme Similarity | Outcome |
|----------|----------|------------------|---------|
| New branch, no PR | N/A | N/A | Create new PR |
| Open PR, more commits | Open | High (≥0.60) | Update existing PR |
| Open PR, different work | Open | Low (<0.40) | Create new PR |
| Merged PR, new commits | Merged | N/A | Create new branch + PR |
| Multi-theme branch | N/A | N/A | Split into themed PRs |

## Error Scenarios

### Error 1: No Git Repository

```bash
$ /mr

❌ Error: Not a git repository
Please run this command from within a git repository.
```

### Error 2: Push Fails

```bash
$ /mr

→ Step 5: Push to remote
  git push -u origin feature/add-charts

❌ Failed to push to remote
Error: remote: Permission to org/repo.git denied

Please check:
- Remote repository access
- Branch protection rules
- Network connectivity
```

### Error 3: PR Creation Fails

```bash
$ /mr

→ Step 6: Create PR
  gh pr create...

❌ Failed to create pull request
Error: HTTP 422: Validation Failed (pull request already exists)

Branch pushed successfully: feature/add-charts
You can create the PR manually at:
https://github.com/org/repo/compare/feature/add-charts
```

## Tips and Best Practices

### Do:
- ✅ Run `/mr` frequently to keep PRs small and focused
- ✅ Use conventional commits for clear commit history
- ✅ Review theme suggestions before selecting
- ✅ Keep original branch if any theme was aborted

### Don't:
- ❌ Run `/mr` with uncommitted changes unless intentional
- ❌ Delete original branch if conflicts occurred during theme splitting
- ❌ Force-push themed branches after creation
- ❌ Split themes for tightly-coupled commits
- ❌ Ignore borderline theme similarity warnings

### When to Use "All Commits" Option:
- All commits are related to same feature
- Only 2-3 commits total
- Theme splitting would create unnecessary overhead
- Commits are tightly coupled (splitting would cause conflicts)

### When to Use Theme Splitting:
- Branch has infrastructure + feature commits
- Dependencies mixed with feature work
- Documentation + code changes
- Multiple independent bug fixes
- Want separate review for different aspects
