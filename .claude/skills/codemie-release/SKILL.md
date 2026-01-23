---
name: codemie-release
description: Release a new version of CodeMie CLI. Use when user says "release", "create release", "publish version", "bump version and release", or wants to publish a new version to npm. Handles version bumping, git tagging, pushing, and GitHub release creation.
---

# CodeMie Release

Automate the release process for CodeMie CLI following semantic versioning.

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

## Version Selection

Determine the target version:

1. If package.json version > latest tag → suggest package.json version
2. Otherwise → increment patch (e.g., 0.0.31 → 0.0.32)
3. **Ask user to confirm** the version or provide alternative

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
# Get commits since last tag for release notes
LAST_TAG=$(git describe --tags --abbrev=0 HEAD^ 2>/dev/null)
git log --oneline --no-merges -10 ${LAST_TAG:+$LAST_TAG..HEAD}

# Create release
gh release create "v<VERSION>" \
  --title "Release v<VERSION>" \
  --notes "## What's Changed

<summary of commits>

**Full Changelog**: https://github.com/EPMCDME/codemie-ai/compare/${LAST_TAG}...v<VERSION>" \
  --latest
```
Skip if release `v<VERSION>` already exists.

## Completion

After successful release, inform user:

- Monitor GitHub Actions for npm publish
- Package available at: `npm install @codemieai/code@<VERSION>`
- View release: `https://github.com/EPMCDME/codemie-ai/releases/tag/v<VERSION>`
