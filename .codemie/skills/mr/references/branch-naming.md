# Branch Naming Reference

## Overview

Branch naming follows a priority system to create descriptive, consistent branch names that provide context at a glance. The `/mr` skill uses a two-tier priority system:

1. **Theme-based naming** (high priority) - When theme detection identifies distinct topics
2. **Semantic naming** (fallback) - Generated from file changes and commit content

**Key principles:**
- Keep names concise (max 50 chars total)
- Use lowercase with hyphens
- Avoid redundant words
- Use common abbreviations (deps, infra, config, perms)
- Handle collisions with numeric suffixes (-2, -3, etc.)

## Priority 1: Theme-Based Naming (High Priority)

**When to use:**
- Theme detected in Step 2.5 (multi-commit theme detection)
- OR theme-based split decided in Step 3.6 (theme mismatch with existing PR)

**Branch name format:**
```
<type>/<subject>
```

### Branch Type Selection

**Determine type based on commit analysis:**

```bash
# Analyze commit titles and file changes
# Count occurrences of type indicators

# Type: feature (most common)
# - New files added
# - "feat:", "Add", "Implement", "Create" in titles
# - New functionality

# Type: fix
# - "fix:", "Fix", "Resolve", "Correct" in titles
# - Bug-related changes

# Type: docs
# - Only .md files or documentation
# - "docs:", "Document", "README", "Update docs" in titles

# Type: refactor
# - "refactor:", "Refactor", "Restructure", "Reorganize" in titles
# - Code changes without new features or fixes
```

**Examples by type:**
- `feature/commit-skill` - New /commit skill added
- `fix/lambda-auth` - Bug fix in Lambda authentication
- `docs/readme-improvements` - Documentation updates
- `refactor/infra-stack` - Infrastructure code reorganization

### Subject Generation

**Algorithm:**

```bash
# 1. Extract most common keywords from commit titles
# - Exclude stopwords (the, a, an, and, or, for, to, in, on, with, add, update, fix, remove)
# - Count frequency across all commits in theme
# - Select top 1-3 keywords

# 2. Determine primary directory from file paths
# - Extract first directory level from all changed files
# - Choose most common directory
# - Use directory name if it provides context

# 3. Combine keywords and directory into subject
# - Join with hyphens
# - Apply abbreviations
# - Truncate to fit within max_length (50 chars total)

# Example:
# Type: "feature" (8 chars + 1 for slash = 9 chars)
# Max subject length: 50 - 9 = 41 chars
# Keywords: ["commit", "skill"]
# Subject: "commit-skill" (12 chars, fits!)
# Branch: "feature/commit-skill"
```

### Examples

**Theme 1: Skills & Tooling**
```
Commits:
- feat: add /commit skill for automated commit messages
- feat: update /mr skill to use /commit

Keywords: skill, commit, mr
Primary dir: .codemie/skills
Type: feature

→ feature/commit-skill
```

**Theme 2: Dependencies**
```
Commits:
- chore: update dependencies across all packages

Keywords: dependencies, update, packages
Primary dir: root (package.json)
Type: chore
Abbreviation: dependencies → deps

→ chore/deps-update
```

### Abbreviations

**Common abbreviations:**

| Full Word | Abbreviation |
|-----------|--------------|
| dependencies | deps |
| infrastructure | infra |
| configuration | config |
| permissions | perms |
| documentation | docs |
| development | dev |
| production | prod |

**Application:**
```bash
# Before abbreviation:
feature/dependencies-update (24 chars - fits)

# After abbreviation:
feature/deps-update (19 chars - more concise)

# Before abbreviation:
fix/infrastructure-permissions (31 chars)

# After abbreviation:
fix/infra-perms (15 chars - fits!)
```

## Priority 2: Semantic Naming (Fallback)

**When to use:**
- No theme detection (single commit or first-time flow)
- Theme detection skipped

**Branch name format:**
```
<type>/<short-description>
```

### Analysis Process

**Step 1: Analyze current changes**

```bash
# Check modified files
git diff --name-only

# Check new files
git ls-files --others --exclude-standard

# Get brief diff summary
git diff --stat
```

**Step 2: Categorize changes by file paths**

```
src/skills/* → Skills and automation
src/cli/* → CLI commands
tests/* → Test changes
docs/* → Documentation
infrastructure/* → Infrastructure changes
.github/workflows/* → CI/CD workflow changes
```

**Step 3: Identify change type**

- **New files** = feat
- **Fixes to existing issues** = fix
- **Documentation only** = docs
- **Code restructuring** = refactor
- **Tests** = test
- **Configuration** = chore

**Step 4: Extract key subject**

- For skills: skill name
- For infrastructure: component name
- For workflows: workflow purpose
- For tests: test scope

**Step 5: Combine into branch name**

```
<type>/<short-subject>
```

Add numeric suffix only if branch name conflicts with existing branch.

### Examples Based on Changes

**Scenario 1: New skill**
```
New files:
- .codemie/skills/add-image/SKILL.md

Analysis:
- Primary: Skills
- Type: feature (new skill)
- Subject: add-image-skill (abbreviated to add-image)

Branch: feature/add-image-skill
```

**Scenario 2: Workflow fix**
```
Modified:
- .github/workflows/ci.yml

Analysis:
- Primary: Workflow file
- Type: fix (permissions error)
- Subject: workflow-perms (abbreviated)

Branch: fix/workflow-perms
```

**Scenario 3: Multi-category changes**
```
Modified:
- src/skills/mr/SKILL.md
- docs/SKILLS.md
- tests/integration/skills.test.ts

Analysis:
- Multiple categories (skills + docs + tests)
- Type: feature (enhancements)
- Subject: mr-skill-enhancements (simplified)

Branch: feature/mr-skill-enhancements
```

### Naming Guidelines

**Keep names concise:**
- Max 50 chars total
- Use abbreviations where clear (perms, infra, config, deps, docs, dev, prod)
- Analyze file paths to determine scope
- Use lowercase with hyphens
- Add short numeric suffix (e.g., `-2`) only if branch name already exists

**Good examples:**
- `feature/mr-skill` (16 chars)
- `fix/workflow-perms` (17 chars)
- `docs/readme` (11 chars)
- `refactor/infra-stack` (20 chars)

**Bad examples:**
- `feature/add-comprehensive-mr-section` (38 chars - TOO LONG)
- `fix/Fix_Workflow_Permissions` (28 chars - wrong case, underscores)
- `feature/the-authentication-feature` (35 chars - unnecessary words)

## Branch Name Validation

**Before creating branch, validate the name:**

```bash
# 1. Check length
if [ ${#BRANCH_NAME} -gt 50 ]; then
  echo "⚠️  Branch name too long (${#BRANCH_NAME} chars, max 50)"
  # Apply abbreviations and truncation
fi

# 2. Check format
if ! echo "$BRANCH_NAME" | grep -qE '^[a-z]+/[a-z0-9-]+$'; then
  echo "⚠️  Invalid branch name format"
  echo "   Expected: <type>/<subject> (lowercase, hyphens only)"
fi

# 3. Check for collision
if git rev-parse --verify "$BRANCH_NAME" >/dev/null 2>&1; then
  echo "⚠️  Branch already exists: $BRANCH_NAME"
  # Add numeric suffix
fi
```

## Creating the Branch

**After determining branch name using one of the two priorities:**

```bash
git checkout -b <new-branch-name>
```

**Report to user:**
```
✓ Created new branch: <new-branch-name>
  Reason: <PR merged/closed | Theme mismatch | New branch>
```

## Edge Cases

### Branch Name Collision

**If branch already exists:**

```bash
# Original: feature/commit-skill
# Check: git rev-parse --verify feature/commit-skill
# Result: exists

# Add -2 suffix
BRANCH_NAME="feature/commit-skill-2"

# Check again: git rev-parse --verify feature/commit-skill-2
# Result: also exists

# Increment to -3
BRANCH_NAME="feature/commit-skill-3"

# Check again: git rev-parse --verify feature/commit-skill-3
# Result: doesn't exist

# Use: feature/commit-skill-3
```

### Very Long Titles

**If theme title is very long:**

```bash
# Commit: "Implement comprehensive user authentication system with MFA"
# (65 characters)

# Extract keywords: authentication, mfa, system
# Apply abbreviations: auth, mfa
# Truncate to fit: auth-mfa-system

# Final branch:
feature/auth-mfa-system
```

### Special Characters

**If title contains special characters:**

```bash
# Commit: "Fix bug in /mr skill (merged PR detection)"

# Processing:
# 1. Convert to lowercase: "fix bug in /mr skill (merged pr detection)"
# 2. Replace non-alphanumeric: "fix-bug-in--mr-skill--merged-pr-detection-"
# 3. Remove duplicate hyphens: "fix-bug-in-mr-skill-merged-pr-detection-"
# 4. Trim leading/trailing: "fix-bug-in-mr-skill-merged-pr-detection"
# 5. Truncate to 50: "fix-bug-in-mr-skill-merged-pr-detection"

# Final branch:
fix/mr-skill-merged-pr-detection
```

## Branch Naming Best Practices

### Do:
- ✅ Use lowercase with hyphens
- ✅ Keep names concise (≤50 chars)
- ✅ Use common abbreviations (deps, infra, config, perms)
- ✅ Use descriptive type prefixes (feature/, fix/, docs/, refactor/)
- ✅ Include primary scope (component, skill name)
- ✅ Follow conventional commit types when possible

### Don't:
- ❌ Use underscores or camelCase
- ❌ Include redundant words (the, a, an)
- ❌ Exceed 50 character limit
- ❌ Use vague names (feature/updates, fix/changes)
- ❌ Use uppercase letters

### Good Examples:
```
feature/commit-skill
fix/lambda-auth
docs/readme-update
refactor/infra-stack
chore/deps-update
test/integration-tests
```

### Bad Examples:
```
feature_mr_skill           (underscores)
feature/add-comprehensive  (too vague)
Feature/MR-Skill          (wrong case)
feature/updates           (vague)
the-fix-for-lambda        (missing type prefix, "the")
```
