# Release Scripts

Simple automation scripts for CodeMie Code releases following KISS principles.

## Usage

### Main Release Script

The `release.sh` script automates the complete release process:

```bash
# Release specific version
./scripts/release.sh 0.0.3

# Auto-increment patch version (0.0.2 → 0.0.3)
./scripts/release.sh

# Preview what would be done (dry run)
./scripts/release.sh --dry-run

# Preview specific version
./scripts/release.sh 0.0.3 --dry-run

# Show help
./scripts/release.sh --help
```

## What it does

The script follows the release process defined in the release-manager documentation:

1. **Pre-flight checks**: Validates git status and existing tags
2. **Version determination**: Auto-increments patch version or uses provided version
3. **Version update**: Updates `package.json` and `package-lock.json`
4. **Git operations**: Commits changes, creates annotated tag, pushes to origin
5. **GitHub release**: Creates GitHub release with auto-generated notes (if `gh` CLI available)

## Requirements

- `git` - Version control operations
- `npm` - Package version management
- `gh` (optional) - GitHub release creation

If `gh` CLI is not available, the script will provide a manual link to create the GitHub release.

## Release Process

Based on CLAUDE.md, the complete release flow is:

```bash
# From CLAUDE.md:
git tag -a v0.0.1 -m "Release version 0.0.1"  # Create release tag
git push origin v0.0.1                         # Push tag to trigger publish
```

The script automates this by:
1. Using `npm version` to update package files
2. Creating proper commit message with Claude Code attribution
3. Creating annotated git tag
4. Pushing both commit and tag
5. Creating GitHub release (triggers npm publish workflow)

## Error Handling

The script includes basic error handling:
- Warns about uncommitted changes (allows override)
- Checks for existing tags (allows override)
- Validates git repository state
- Uses `set -e` to exit on errors

## Simple by Design

Following KISS principles, this script:
- Is a single file with no dependencies
- Uses basic bash constructs
- Provides clear output and prompts
- Handles the most common release scenarios
- Can be extended easily if needed

The release-manager agent can run this script instead of individual git commands, making releases more reliable and consistent.

## Proxy Endpoint Smoke Test

`scripts/test-proxy-endpoint.js` sends a small sample request to a local proxy or upstream HTTP endpoint.

```bash
node scripts/test-proxy-endpoint.js --url http://127.0.0.1:4001
```

By default it posts to `/v1/messages` with a minimal messages payload. Override the request path or prompt when needed:

```bash
node scripts/test-proxy-endpoint.js --url http://127.0.0.1:4001 --endpoint /v1/messages --message "hello"
```
