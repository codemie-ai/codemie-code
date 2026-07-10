# Spec: Claude Code CLI Version Enforcement in Test Setup

## Problem

`tests/setup/agent-build-setup.ts` only checks whether the `claude` binary exists. It does not verify the installed version against `CLAUDE_SUPPORTED_VERSION` in `claude.plugin.ts`. When a developer bumps `CLAUDE_SUPPORTED_VERSION` locally and runs agent integration tests, the tests continue using whatever version is globally installed — which may differ. This breaks the invariant that tests always run against the exact supported version.

## Goal

When agent integration tests run, ensure the installed `claude` binary is exactly `CLAUDE_SUPPORTED_VERSION`. If the installed version differs (newer or older) or is missing, install the supported version, overriding the user's global install.

## Scope

Two files only:

1. `src/agents/plugins/claude/claude.plugin.ts` — export `CLAUDE_SUPPORTED_VERSION`
2. `tests/setup/agent-build-setup.ts` — replace the presence-only check with a version-aware check

No new test files. No changes to any other production source.

## Design

### 1. Export `CLAUDE_SUPPORTED_VERSION`

Change the declaration from:

```ts
const CLAUDE_SUPPORTED_VERSION = '2.1.199';
```

to:

```ts
export const CLAUDE_SUPPORTED_VERSION = '2.1.199';
```

This is purely additive. All internal usages are unchanged. The export makes the constant importable by `agent-build-setup.ts` and any future tooling without going through `ClaudePluginMetadata`.

### 2. Version-aware setup in `agent-build-setup.ts`

The existing try/catch block that checks for `claude` presence and installs if missing is replaced with the following logic, executed after `npm run build`:

1. Import `CLAUDE_SUPPORTED_VERSION` and `ClaudePlugin` from `dist/agents/plugins/claude/claude.plugin.js` (the build already ran at this point).
2. Attempt `execSync('claude --version', { stdio: 'pipe' })`. Extract the semver using `/^(\d+\.\d+\.\d+)/` — matches Claude's own parsing logic.
3. **If the extracted version equals `CLAUDE_SUPPORTED_VERSION`**: log and skip installation.
4. **Otherwise** (version mismatch or binary absent): log the reason, then `await new ClaudePlugin().installVersion('supported')`. This resolves `'supported'` to `CLAUDE_SUPPORTED_VERSION`, runs `installNativeAgent` with `--force`, and overrides whatever version the user has globally installed.
5. Re-add `~/.local/bin` to `process.env.PATH` after install (matches existing pattern).
6. Verify with `execSync('claude --version', { stdio: 'pipe' })` — throws if installation genuinely failed.

### Version comparison

String equality (`===`) on the extracted semver is sufficient. Both sides are resolved to clean `major.minor.patch` strings before comparison. No need for `compareVersions` from `version-utils.ts` — we are not checking ranges, only exact match.

## Behaviour Summary

| Installed version | Action |
|---|---|
| Not installed | Install `CLAUDE_SUPPORTED_VERSION` |
| Matches `CLAUDE_SUPPORTED_VERSION` | Skip — already correct |
| Older than `CLAUDE_SUPPORTED_VERSION` | Install `CLAUDE_SUPPORTED_VERSION` (force) |
| Newer than `CLAUDE_SUPPORTED_VERSION` | Install `CLAUDE_SUPPORTED_VERSION` (force) |

## Out of Scope

- Unit tests for the version enforcement logic
- Changes to the `codemie install` CLI command
- Changes to `BaseAgentAdapter.checkVersionCompatibility`
- CI pipeline changes
