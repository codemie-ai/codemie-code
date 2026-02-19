---
name: codemie-release
description: Release a new version of CodeMie CLI. Use when user says "release", "create release", "publish version", "bump version and release", or wants to publish a new version to npm. Handles version bumping, git tagging, pushing, and GitHub release creation with automatic version detection from conventional commits.
---

# CodeMie Release

Automate the release process for CodeMie CLI following semantic versioning and conventional commits.

## Pre-flight Checks

Before starting, verify:

1. **Branch**: Must be on `main`. If not, stop and ask user to switch.
2. **Working directory**: Check for uncommitted changes. Warn if present.
3. **Current state**: Determine what's already done:
   ```bash
   # Current version
   grep '"version"' package.json | sed 's/.*"version": "\(.*\)".*/\1/'

   # Latest tag
   git describe --tags --abbrev=0 2>/dev/null

   # Check if tag exists
   git tag -l "v<VERSION>"

   # Check if release exists
   gh release view "v<VERSION>" 2>/dev/null
   ```

## Analyze Commits and Determine Version

**CRITICAL**: Always analyze commits to determine the appropriate version bump based on conventional commit types.

### 1. Get Commit Delta

```bash
# Get commits since last release (excluding version bump commits)
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null)
git log --pretty=format:"%s" ${LAST_TAG:+$LAST_TAG..HEAD} | grep -v "^chore: bump version"
```

### 2. Analyze Commit Types

Parse each commit message to identify type:

**Conventional Commit Format**: `<type>(<scope>): <subject>`
- **Types**: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`, `ci`, `revert`
- **Scopes** (optional): `cli`, `agents`, `providers`, `assistants`, `config`, `proxy`, `workflows`, `ci`, `analytics`, `utils`, `deps`, `tests`, `skills`

**Breaking Changes**: Check commit bodies for `BREAKING CHANGE:` footer
```bash
# Check for breaking changes
git log --pretty=format:"%B" ${LAST_TAG:+$LAST_TAG..HEAD} | grep -q "BREAKING CHANGE:"
```

### 3. Determine Version Bump

**Version bump rules** (highest precedence wins):

1. **MAJOR** bump (x.0.0) - If any commit contains `BREAKING CHANGE:` in body
2. **MINOR** bump (0.x.0) - If any commit has `feat:` or `feat(scope):`
3. **PATCH** bump (0.0.x) - If only `fix:`, `refactor:`, `perf:`, `docs:`, `style:`, `test:`, `chore:`, `ci:`, `revert:`

### 4. Calculate Target Version

```bash
# Current version from package.json
CURRENT=$(grep '"version"' package.json | sed 's/.*"version": "\(.*\)".*/\1/')

# Parse version parts (e.g., "0.0.35" → major=0, minor=0, patch=35)
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

# Apply bump based on commit analysis:
# - If BREAKING CHANGE found: MAJOR=$((MAJOR+1)), MINOR=0, PATCH=0
# - If feat: found: MINOR=$((MINOR+1)), PATCH=0
# - Otherwise: PATCH=$((PATCH+1))

TARGET_VERSION="$MAJOR.$MINOR.$PATCH"
```

### 5. Present Recommendation

Show the user:
- **Current version**: e.g., `0.0.35`
- **Commits analyzed**: List of commit subjects
- **Detected bump type**: MAJOR/MINOR/PATCH with explanation
- **Recommended version**: e.g., `0.0.36`
- **Ask user to confirm** or provide alternative

Example output:
```
📦 Current version: 0.0.35
📊 Analyzed 3 commits since v0.0.35:
  - fix(utils): auto-update PATH during Claude installation on Windows (#120)
  - refactor(skills): relocate skills module to codemie-code agent (#117)

🔍 Detected: PATCH bump (only fixes and refactors found)
🎯 Recommended version: 0.0.36

Confirm release version 0.0.36?
```

## Generate Release Notes

**CRITICAL**: Group commits by type and generate concrete, user-focused release notes.

### 1. Categorize Commits

```bash
# Get full commit messages since last tag
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null)
git log --pretty=format:"%s|%b" ${LAST_TAG:+$LAST_TAG..HEAD} | grep -v "^chore: bump version"
```

Group commits by type:
- **✨ Features** (feat)
- **🐛 Bug Fixes** (fix)
- **⚡ Performance** (perf)
- **♻️ Refactoring** (refactor)
- **📚 Documentation** (docs)
- **🔧 Maintenance** (chore, ci, test, style)

### 2. Extract Concrete Details

For each commit:
- Remove type prefix: `feat(agents): add feature` → `add feature`
- Capitalize first letter: `add feature` → `Add feature`
- Keep PR numbers: `(#123)`
- Extract scope for context: `feat(agents):` → show as "[agents]"

### 3. Format Breaking Changes

If breaking changes exist:
```markdown
## ⚠️ BREAKING CHANGES

- **[scope]**: Description of what broke and how to migrate
```

Extract from commit body after `BREAKING CHANGE:` line.

### 4. Release Notes Template

```markdown
## What's Changed

### ✨ Features
- **[scope]**: Feature description (#PR)

### 🐛 Bug Fixes
- **[scope]**: Fix description (#PR)

### ⚡ Performance Improvements
- **[scope]**: Performance improvement (#PR)

### ♻️ Refactoring
- **[scope]**: Refactoring description (#PR)

### 📚 Documentation
- **[scope]**: Documentation change (#PR)

### 🔧 Maintenance
- **[scope]**: Maintenance task (#PR)

**Full Changelog**: https://github.com/codemie-ai/codemie-code/compare/${LAST_TAG}...v<VERSION>
```

**Example concrete release notes**:
```markdown
## What's Changed

### 🐛 Bug Fixes
- **[utils]**: Auto-update PATH during Claude installation on Windows (#120)

### ♻️ Refactoring
- **[skills]**: Relocate skills module to codemie-code agent (#117)

**Full Changelog**: https://github.com/codemie-ai/codemie-code/compare/v0.0.35...v0.0.36
```

## Release Steps

Execute each step, **skipping if already completed**:

### 1. Update Version

```bash
npm version <VERSION> --no-git-tag-version
```
Skip if package.json already at target version.

### 2. Commit Version Bump

```bash
git add package.json package-lock.json
git commit -m "chore: bump version to <VERSION>

🤖 Generated with release script"
```
Skip if commit message `chore: bump version to <VERSION>` exists in HEAD.

### 3. Create Tag

```bash
git tag -a "v<VERSION>" -m "Release version <VERSION>"
```
Skip if tag `v<VERSION>` already exists.

### 4. Push to Origin

```bash
git push origin main
git push origin "v<VERSION>"
```

### 5. Create GitHub Release

```bash
# Create release with generated notes
gh release create "v<VERSION>" \
  --title "Release v<VERSION>" \
  --notes "<GENERATED_RELEASE_NOTES>" \
  --latest
```
Skip if release `v<VERSION>` already exists.

Use the concrete, categorized release notes generated in the previous section.

## Completion

After successful release, inform user:

- ✅ Release v<VERSION> created successfully
- 🔄 Monitor [GitHub Actions](https://github.com/codemie-ai/codemie-code/actions) for npm publish
- 📦 Package will be available at: `npm install @codemieai/code@<VERSION>`
- 🔗 View release: `https://github.com/codemie-ai/codemie-code/releases/tag/v<VERSION>`
