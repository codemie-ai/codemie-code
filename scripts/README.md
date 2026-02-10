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
3. **Version update**: Updates `package.json` and `bun.lock`
4. **Git operations**: Commits changes, creates annotated tag, pushes to origin
5. **GitHub release**: Creates GitHub release with auto-generated notes (if `gh` CLI available)

## Requirements

- `git` - Version control operations
- `bun` - Package manager (for lockfile updates)
- `npm` - Used for `npm version` command (semantic versioning helper)
- `gh` (optional) - GitHub release creation

If `gh` CLI is not available, the script will provide a manual link to create the GitHub release.

**Note:** While the project uses Bun for development, the release script uses `npm version` as a helper to update package.json, then regenerates bun.lock.

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