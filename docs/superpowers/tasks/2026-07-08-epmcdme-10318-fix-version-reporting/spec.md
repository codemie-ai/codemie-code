# Spec: Fix version reporting after `codemie install claude <version>`

**Ticket**: EPMCDME-10318  
**Branch**: EPMCDME-10318_fix-version-reporting

## Problem

When a user installs a new Claude version over an existing one, the CLI success message reports the old version instead of the newly installed one.

```
Installing Claude Code v2.1.34...
✓ Claude Code v2.1.33 installed successfully   ← wrong
```

Two root causes:

1. `ClaudePlugin.installVersion()` returns `void`, discarding the verified installed version that `installNativeAgent()` → `verifyInstallation()` already computed correctly.
2. The post-install `agent.getVersion()` call in `install.ts` can silently fall back to the old PATH-based binary (e.g., an npm-installed previous version) if the full-path exec fails for any reason (timing, OS file-lock, brief permission change during binary replacement).

## Goal

The CLI success message always reflects the version that was actually installed. If verification silently failed, the message degrades gracefully rather than showing a wrong version.

## Acceptance criteria

- `codemie install claude 2.1.34` over an existing 2.1.33 reports `Claude Code v2.1.34 installed successfully`.
- Downgrade scenario (`2.1.34 → 2.1.33`) reports the correct lower version.
- When post-install verification produces no version (e.g., Windows PATH-refresh delay), the success message omits the version number rather than showing a stale one.
- No regressions in `update` or `setup` flows that also call `installVersion()`.

## Design

### Interface change

`AgentAdapter.installVersion()` return type changes from `Promise<void>` to `Promise<string | null>`:

```ts
// src/agents/core/types.ts
installVersion?(version: string): Promise<string | null>;
```

### Data flow

```
installNativeAgent() → NativeInstallResult { installedVersion: '2.1.34' }
  └→ ClaudePlugin.installVersion()  returns '2.1.34'
       └→ install.ts                uses it in spinner.succeed()
```

`install.ts` captures the return value and only falls back to `getVersion()` when it is `null`:

```ts
const installedVersion = versionToInstall && agent.installVersion
  ? await agent.installVersion(versionToInstall)
  : null;
const displayVersion = installedVersion ?? await agent.getVersion();
spinner.succeed(`${agent.displayName}${displayVersion ? ` v${displayVersion}` : ''} installed successfully`);
```

### Per-file changes

| File | Change |
|---|---|
| `src/agents/core/types.ts` | `installVersion?()` return type: `Promise<void>` → `Promise<string \| null>` |
| `src/agents/core/BaseAgentAdapter.ts` | Return `await this.getVersion()` after `npm.installGlobal()` |
| `src/agents/plugins/claude/claude.plugin.ts` | Return `result.installedVersion ?? null` from `installVersion()`; add `shell: true` to primary exec in `getVersion()` |
| `src/agents/plugins/kimi/kimi.plugin.ts` | Return `await this.getVersion()` after `this.installNative()` |
| `src/cli/commands/install.ts` | Capture return value of `installVersion()`; use it for success message; fall back to `getVersion()` when null |
| `src/agents/plugins/kimi/__tests__/kimi.plugin.test.ts` | Update 6 assertions from `.resolves.toBeUndefined()` to `.resolves.not.toThrow()` or check for string/null |
| `src/cli/commands/__tests__/install.version-selection.test.ts` | Update mock return value; add test for null-fallback path |

### `getVersion()` hardening

Add `shell: true` to the primary `exec` call in `ClaudePlugin.getVersion()`. This mirrors what `verifyInstallation()` already does and prevents the silent fallback to the old PATH binary independently of the return-type change:

```ts
// before
const result = await exec(fullPath, ['--version']);
// after
const result = await exec(fullPath, ['--version'], { shell: true });
```

### Callers unaffected

`update.ts` and `setup.ts` call `installVersion()` and ignore the return value. No changes needed — they will silently ignore `string | null` as they previously ignored `void`.

## Out of scope

- Changes to the `uninstall`, `run`, or analytics flows.
- Retry logic in `getVersion()` beyond the `shell: true` hardening.
- Any UI surface other than the install command's spinner success message.
