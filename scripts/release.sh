#!/bin/bash
# Note: Do NOT use 'set -e' to allow recovery from individual step failures

# CodeMie Code Release Script
# Simple script to automate releases following KISS principles
# Designed to be resumable - can continue from failed steps
#
# Release flow: version bump → commit → agent tests gate → tag → push → GitHub release
# Agent tests gate: runs `npx vitest run --project agent` before tagging.
#   - Tests pass → continue automatically
#   - Tests fail → release blocked (fix tests first)
#   - Tests cannot run (missing SSO/JWT credentials) → manual confirmation required

DRY_RUN=false
VERSION=""

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --dry-run) DRY_RUN=true; shift ;;
        --help|-h)
            echo "Usage: $0 [VERSION] [--dry-run]"
            echo "Examples:"
            echo "  $0 0.0.3        # Release version 0.0.3"
            echo "  $0 --dry-run    # Preview next patch release"
            exit 0 ;;
        *) VERSION="$1"; shift ;;
    esac
done

# Get current version from package.json
CURRENT=$(grep '"version"' package.json | sed 's/.*"version": "\(.*\)".*/\1/')
echo "Current version in package.json: $CURRENT"

# Get latest released tag
LATEST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
if [[ -n "$LATEST_TAG" ]]; then
    LATEST_VERSION="${LATEST_TAG#v}"
    echo "Latest released version: $LATEST_VERSION"
else
    LATEST_VERSION=""
    echo "No previous releases found"
fi

# Determine suggested version
SUGGESTED_VERSION=""
if [[ -z "$VERSION" ]]; then
    # Check if current package.json version is already ahead of latest release
    if [[ -n "$LATEST_VERSION" && "$CURRENT" != "$LATEST_VERSION" ]]; then
        # package.json is ahead but not released - use it
        SUGGESTED_VERSION="$CURRENT"
        echo "Suggested version (from package.json): $SUGGESTED_VERSION"
    elif [[ -z "$LATEST_VERSION" ]]; then
        # No releases yet - use package.json version
        SUGGESTED_VERSION="$CURRENT"
        echo "Suggested version (initial): $SUGGESTED_VERSION"
    else
        # Auto-increment patch version from latest release
        IFS='.' read -r major minor patch <<< "$LATEST_VERSION"
        SUGGESTED_VERSION="$major.$minor.$((patch + 1))"
        echo "Suggested version (+1 patch): $SUGGESTED_VERSION"
    fi

    # Prompt user for version (unless in dry-run mode)
    if [[ "$DRY_RUN" == "false" ]]; then
        echo ""
        read -p "Enter release version [$SUGGESTED_VERSION]: " USER_VERSION
        if [[ -n "$USER_VERSION" ]]; then
            VERSION="$USER_VERSION"
            echo "Using custom version: $VERSION"
        else
            VERSION="$SUGGESTED_VERSION"
            echo "Using suggested version: $VERSION"
        fi
    else
        VERSION="$SUGGESTED_VERSION"
    fi
else
    echo "Version specified via argument: $VERSION"
fi

echo ""
echo "Target version: $VERSION"

# Pre-flight checks
echo ""
echo "🔍 Pre-flight checks:"

# Check what's already done
CURRENT_PKG_VERSION=$(grep '"version"' package.json | sed 's/.*"version": "\(.*\)".*/\1/')
VERSION_UPDATED=false
VERSION_COMMITTED=false
TAG_EXISTS=false
RELEASE_EXISTS=false

if [[ "$CURRENT_PKG_VERSION" == "$VERSION" ]]; then
    VERSION_UPDATED=true
    echo "✅ package.json already at version $VERSION"
else
    echo "⏭️  package.json needs update to $VERSION"
fi

COMMIT_MSG="chore: bump version to $VERSION"
if git log -1 --pretty=%B | grep -q "$COMMIT_MSG"; then
    VERSION_COMMITTED=true
    echo "✅ Version bump already committed"
else
    echo "⏭️  Version bump needs to be committed"
fi

if git tag -l "v$VERSION" | grep -q "v$VERSION"; then
    TAG_EXISTS=true
    echo "✅ Tag v$VERSION already exists"
else
    echo "⏭️  Tag v$VERSION needs to be created"
fi

if command -v gh >/dev/null 2>&1 && gh release view "v$VERSION" >/dev/null 2>&1; then
    RELEASE_EXISTS=true
    echo "✅ GitHub Release v$VERSION already exists"
elif command -v gh >/dev/null 2>&1; then
    echo "⏭️  GitHub Release needs to be created"
fi

# Check git status
if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "⚠️  Working directory has uncommitted changes"
    if [[ "$DRY_RUN" == "false" ]]; then
        read -p "Continue anyway? (y/N): " -n 1 -r
        echo
        [[ ! $REPLY =~ ^[Yy]$ ]] && exit 1
    fi
fi

# Show what will be done
echo ""
echo "📋 Actions that will be performed:"
STEP=1
if [[ "$VERSION_UPDATED" == "false" ]]; then
    echo "$STEP. Update package.json version to $VERSION"
    STEP=$((STEP + 1))
fi
if [[ "$VERSION_COMMITTED" == "false" ]]; then
    echo "$STEP. Commit version bump"
    STEP=$((STEP + 1))
fi
if [[ "$TAG_EXISTS" == "false" ]]; then
    echo "$STEP. Create git tag v$VERSION"
    STEP=$((STEP + 1))
fi
echo "$STEP. Run agent tests (or confirm manual run if credentials unavailable)"
STEP=$((STEP + 1))
echo "$STEP. Push commit and tag to origin"
STEP=$((STEP + 1))
if command -v gh >/dev/null 2>&1 && [[ "$RELEASE_EXISTS" == "false" ]]; then
    echo "$STEP. Create GitHub Release"
fi

# If everything is done, just need to push
if [[ "$VERSION_UPDATED" == "true" && "$VERSION_COMMITTED" == "true" && "$TAG_EXISTS" == "true" ]]; then
    echo ""
    echo "ℹ️  Version $VERSION is ready - only push and release creation needed"
fi

if [[ "$DRY_RUN" == "true" ]]; then
    echo ""
    echo "🔍 DRY RUN - No changes will be made"
    exit 0
fi

echo ""
read -p "❓ Proceed with release? (y/N): " -n 1 -r
echo
[[ ! $REPLY =~ ^[Yy]$ ]] && exit 1

# Execute release
echo ""
echo "🚀 Executing release..."

# Update version in package.json and package-lock.json
echo "📝 Updating package versions..."
CURRENT_PKG_VERSION=$(grep '"version"' package.json | sed 's/.*"version": "\(.*\)".*/\1/')
if [[ "$CURRENT_PKG_VERSION" == "$VERSION" ]]; then
    echo "⏭️  package.json already at version $VERSION, skipping version update..."
else
    npm version "$VERSION" --no-git-tag-version || {
        echo "⚠️  Failed to update package version, but continuing..."
    }
fi

# Commit changes
echo "💾 Committing version bump..."
COMMIT_MSG="chore: bump version to $VERSION"
if git log -1 --pretty=%B | grep -q "$COMMIT_MSG"; then
    echo "⏭️  Version bump already committed, skipping commit..."
else
    git add package.json package-lock.json
    git commit -m "$COMMIT_MSG

🤖 Generated with release script" || {
        echo "⚠️  Failed to commit (possibly already committed), continuing..."
    }
fi

# Run agent tests before tagging — gate the release on test outcome
echo ""
echo "🧪 Running agent tests..."
AGENT_TEST_JSON=$(mktemp /tmp/agent-test-XXXXX.json) || { echo "ERROR: mktemp failed, cannot capture agent test results"; exit 1; }
trap 'rm -f "$AGENT_TEST_JSON"' EXIT INT TERM
npx vitest run --project agent --reporter=verbose --reporter=json --outputFile="$AGENT_TEST_JSON"
AGENT_EXIT_CODE=$?

AGENT_PASSED=0
if [[ -f "$AGENT_TEST_JSON" ]]; then
    AGENT_PASSED=$(node -e "const fs=require('fs');try{const r=JSON.parse(fs.readFileSync('$AGENT_TEST_JSON','utf8'));console.log(r.numPassedTests||0)}catch{console.log(0)}")
fi
rm -f "$AGENT_TEST_JSON"

if [[ $AGENT_EXIT_CODE -ne 0 ]]; then
    echo ""
    echo "❌ Agent tests FAILED (exit code $AGENT_EXIT_CODE). Release cannot proceed."
    echo "   Fix the failing agent tests before releasing."
    exit 1
elif [[ "$AGENT_PASSED" -gt 0 ]]; then
    echo "✅ Agent tests passed ($AGENT_PASSED tests)"
else
    echo ""
    echo "⚠️  Agent tests could not run automatically (0 tests executed)."
    echo "   This usually means SSO credentials or network access are unavailable."
    echo ""
    echo "   Why agent tests are required:"
    echo "   Agent tests validate the full codemie-code integration against a live"
    echo "   CodeMie server. Skipping them risks releasing broken agent behavior."
    echo ""
    echo "   To run agent tests automatically:"
    echo "   • Local: ensure your active profile uses provider 'ai-run-sso'"
    echo "     (check: cat ~/.codemie/codemie-cli.config.json)"
    echo "   • CI:    set CI_IS_LOCAL_RUN=false and provide tests/.env.test.local"
    echo ""
    echo "   To run manually: npx vitest run --project agent"
    echo ""
    read -p "❓ Have you manually run agent tests and confirmed they pass? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "❌ Release aborted — agent tests must pass before releasing."
        exit 1
    fi
    echo "✅ Agent tests manually confirmed by user"
fi

# Create tag (skip if exists)
if git tag -l "v$VERSION" | grep -q "v$VERSION"; then
    echo "⏭️  Tag v$VERSION already exists, skipping tag creation..."
else
    echo "🏷️  Creating tag v$VERSION..."
    git tag -a "v$VERSION" -m "Release version $VERSION" || {
        echo "⚠️  Failed to create tag, but continuing..."
    }
fi

# Push to origin
echo "📤 Pushing to origin..."
git push origin main || {
    echo "⚠️  Failed to push main branch, but continuing..."
}
git push origin "v$VERSION" || {
    echo "⚠️  Failed to push tag (possibly already pushed), continuing..."
}

# Create GitHub release if gh CLI is available
if command -v gh >/dev/null 2>&1; then
    echo "🐱 Creating GitHub Release..."

    # Check if release already exists
    if gh release view "v$VERSION" >/dev/null 2>&1; then
        echo "⏭️  GitHub Release v$VERSION already exists, skipping..."
    else
        # Generate simple release notes
        LAST_TAG=$(git describe --tags --abbrev=0 HEAD^ 2>/dev/null || echo "")
        if [[ -n "$LAST_TAG" ]]; then
            COMMITS=$(git log "$LAST_TAG..HEAD" --oneline --no-merges | wc -l)
            RANGE="$LAST_TAG..v$VERSION"
        else
            COMMITS=$(git rev-list --count HEAD)
            RANGE="v$VERSION"
        fi

        # Create release notes
        cat > /tmp/release-notes.md << EOF
## What's Changed

This release includes $COMMITS commits with improvements and updates.

### Recent Changes:
$(git log --oneline --no-merges -10 ${LAST_TAG:+$LAST_TAG..HEAD} | sed 's/^/- /')

**Full Changelog**: https://github.com/EPMCDME/codemie-ai/compare/${LAST_TAG:-initial}...v$VERSION
EOF

        gh release create "v$VERSION" \
            --title "Release v$VERSION" \
            --notes-file /tmp/release-notes.md \
            --latest || {
            echo "⚠️  Failed to create GitHub release, but continuing..."
        }

        rm -f /tmp/release-notes.md
        echo "✅ GitHub Release created"
    fi
else
    echo "⚠️  GitHub CLI not available - create release manually at:"
    echo "   https://github.com/EPMCDME/codemie-ai/releases/new?tag=v$VERSION"
fi

echo ""
echo "🎉 Release v$VERSION completed successfully!"
echo ""
echo "📦 Next steps:"
echo "• Monitor GitHub Actions for npm publish: https://github.com/EPMCDME/codemie-ai/actions"
echo "• Package will be available: npm install @codemieai/code@$VERSION"
echo "• View release: https://github.com/EPMCDME/codemie-ai/releases/tag/v$VERSION"