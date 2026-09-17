# Fix Version Reporting After `codemie install claude <version>` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the CLI success message so it always reports the version that was actually installed, not the version found by a second `getVersion()` call that may see a stale PATH binary.

**Architecture:** Change `AgentAdapter.installVersion()` return type from `Promise<void>` to `Promise<string | null>`, propagate the verified version from `installNativeAgent()` up through each plugin, and update `install.ts` to use that return value for the success message — falling back to `getVersion()` only when the return is `null`.

**Tech Stack:** TypeScript 5, Node.js ≥ 20, Vitest (tests), Commander (CLI), native OS installer scripts.

## Global Constraints

- ES modules only — all imports end in `.js`, use `@/` alias for `src/` root imports.
- No `any` type; explicit return types on all exports.
- Error handling: throw `AgentInstallationError` for install failures; `getVersion()` returns `null` on failure (never throws).
- Logging: `logger.success()` / `logger.info()` / `logger.debug()` from `@/utils/logger.js`.
- Commit messages: Conventional Commits format (e.g., `fix: …`); reference slug `EPMCDME-10318`.
- Run `npm run typecheck` after every implementation step before committing.

---

### Task 1: Fix version propagation in the Claude + npm install path

**Files:**
- Modify: `src/agents/core/types.ts` (line 774)
- Modify: `src/agents/core/BaseAgentAdapter.ts` (lines 127, 153)
- Modify: `src/agents/plugins/claude/claude.plugin.ts` (lines 371, 474, 581)
- Modify: `src/cli/commands/install.ts` (lines 178–191, 199)
- Test: `src/cli/commands/__tests__/install.version-selection.test.ts`

**Interfaces:**
- Produces: `AgentAdapter.installVersion?(version: string): Promise<string | null>` — changed from `Promise<void>`
- Produces: `ClaudePlugin.installVersion()` returns `result.installedVersion ?? null`
- Produces: `BaseAgentAdapter.installVersion()` returns `await this.getVersion()` after npm install
- Produces: `install.ts` lines 178–191 use `installVersion()` return; fall back to `getVersion()` only when null

Test-first: yes — new test asserts spinner receives the version returned by `installVersion()`, not the value of a subsequent `getVersion()` call.

- [ ] **Step 1: Add two failing tests to `install.version-selection.test.ts`**

Add both tests inside the existing `describe('install command version selection', ...)` block, after the existing test. Also update the mock in the existing test from `mockResolvedValue(undefined)` to `mockResolvedValue('0.129.0')`.

```ts
// UPDATE existing test mock (line 42):
// Before: const installVersion = vi.fn().mockResolvedValue(undefined);
// After:
const installVersion = vi.fn().mockResolvedValue('0.129.0');
```

New tests to add at the end of the describe block:

```ts
it('uses the version returned by installVersion() for the success message', async () => {
  const installVersion = vi.fn().mockResolvedValue('2.1.34');
  const getVersion = vi.fn().mockResolvedValue('2.1.33'); // stale — must NOT appear in spinner

  getAgentMock.mockReturnValue({
    name: 'claude',
    displayName: 'Claude Code',
    description: 'Claude Code - AI coding agent by Anthropic',
    metadata: {},
    isInstalled: vi.fn().mockResolvedValue(false),
    install: vi.fn().mockResolvedValue(undefined),
    installVersion,
    checkVersionCompatibility: vi.fn().mockResolvedValue({
      supportedVersion: '2.1.34',
      installedVersion: null,
      compatible: false,
      isNewer: false,
      hasUpdate: false,
      isBelowMinimum: false,
      minimumSupportedVersion: '2.1.199',
    }),
    getVersion,
  });

  const { createInstallCommand } = await import('../install.js');
  const command = createInstallCommand();

  await command.parseAsync(['node', 'codemie', 'claude']);

  expect(installVersion).toHaveBeenCalledWith('supported');
  // Must show the version from installVersion(), not the stale '2.1.33' from getVersion()
  expect(spinnerSucceedMock).toHaveBeenCalledWith('Claude Code v2.1.34 installed successfully');
});

it('falls back to getVersion() when installVersion() returns null', async () => {
  const installVersion = vi.fn().mockResolvedValue(null);
  const getVersion = vi.fn().mockResolvedValue('2.1.34');

  getAgentMock.mockReturnValue({
    name: 'claude',
    displayName: 'Claude Code',
    description: 'Claude Code - AI coding agent by Anthropic',
    metadata: {},
    isInstalled: vi.fn().mockResolvedValue(false),
    install: vi.fn().mockResolvedValue(undefined),
    installVersion,
    checkVersionCompatibility: vi.fn().mockResolvedValue({
      supportedVersion: '2.1.34',
      installedVersion: null,
      compatible: false,
      isNewer: false,
      hasUpdate: false,
      isBelowMinimum: false,
      minimumSupportedVersion: '2.1.199',
    }),
    getVersion,
  });

  const { createInstallCommand } = await import('../install.js');
  const command = createInstallCommand();

  await command.parseAsync(['node', 'codemie', 'claude']);

  expect(getVersion).toHaveBeenCalled(); // fallback path exercised
  expect(spinnerSucceedMock).toHaveBeenCalledWith('Claude Code v2.1.34 installed successfully');
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```
cd C:\Projects\codemie-dev\codemie-code
npx vitest run src/cli/commands/__tests__/install.version-selection.test.ts
```

Expected: 2 new tests FAIL.
- "uses the version returned by installVersion()" fails with `Expected: 'Claude Code v2.1.34…' Received: 'Claude Code v2.1.33…'` (stale getVersion result)
- "falls back to getVersion()" fails because current code always calls getVersion(), not via the null-check path

- [ ] **Step 3: Change `installVersion` return type in `src/agents/core/types.ts`**

Line 774:
```ts
// Before:
installVersion?(version: string): Promise<void>;

// After:
installVersion?(version: string): Promise<string | null>;
```

- [ ] **Step 4: Update `BaseAgentAdapter.installVersion()` in `src/agents/core/BaseAgentAdapter.ts`**

Line 127 — change return type:
```ts
// Before:
async installVersion(version?: string): Promise<void> {

// After:
async installVersion(version?: string): Promise<string | null> {
```

Line 153 — add return after the try/catch block (after the closing `}` of the catch, before the closing `}` of the function):
```ts
  // ... existing try/catch ...
  }
  return await this.getVersion();
}
```

Full function after change (lines 127–154):
```ts
async installVersion(version?: string): Promise<string | null> {
  if (!this.metadata.npmPackage) {
    throw new Error(`${this.displayName} is built-in and cannot be installed`);
  }

  let resolvedVersion: string | undefined = version;
  if (version === 'supported') {
    if (!this.metadata.supportedVersion) {
      throw new Error(`${this.displayName}: No supported version defined in metadata`);
    }
    resolvedVersion = this.metadata.supportedVersion;
    logger.debug('Resolved version', {
      from: 'supported',
      to: resolvedVersion,
    });
  }

  try {
    await npm.installGlobal(this.metadata.npmPackage, { version: resolvedVersion });
  } catch (error: unknown) {
    if (error instanceof NpmError) {
      throw new Error(`Failed to install ${this.displayName}: ${error.message}`);
    }
    throw error;
  }
  return await this.getVersion();
}
```

- [ ] **Step 5: Update `ClaudePlugin.installVersion()` in `src/agents/plugins/claude/claude.plugin.ts`**

**Change 1 — `getVersion()` primary exec (line 371): add `shell: true`**

```ts
// Before (line 371):
const result = await exec(fullPath, ['--version']);

// After:
const result = await exec(fullPath, ['--version'], { shell: true });
```

**Change 2 — `installVersion()` return type (line 474):**

```ts
// Before:
async installVersion(version?: string): Promise<void> {

// After:
async installVersion(version?: string): Promise<string | null> {
```

**Change 3 — `installVersion()` return value (line 581): add return before closing brace of function**

The current function ends at line 581 (`}`). The last executed statement is the `if (isWindows)` block inside the `else` branch. Insert `return result.installedVersion ?? null;` after the closing `}` of the `if (result.installedVersion) { ... } else { ... }` block and before the function's closing `}`:

```ts
    // ... existing if (result.installedVersion) { ... } else { ... } block at lines 551–580 ...

    return result.installedVersion ?? null;
  }
```

The complete end of the function after the change:

```ts
    // Log success with version verification status
    if (result.installedVersion) {
      logger.success(
        `${metadata.displayName} ${result.installedVersion} installed successfully`,
      );
    } else {
      const isWindows = process.platform === 'win32';
      logger.success(
        `${metadata.displayName} ${resolvedVersion || 'latest'} installation completed`,
      );

      if (isWindows) {
        logger.info(
          'Note: Command verification requires restarting your terminal on Windows.',
        );
        logger.info(
          `After restart, verify with: ${metadata.cliCommand} --version`,
        );
      } else {
        logger.warn(
          'Installation completed but command verification failed.',
        );
        logger.info(
          'Possible causes: PATH not updated, slow filesystem, or permission issues.',
        );
        logger.info(
          `Try: 1) Restart your shell/terminal, or 2) Run: ${metadata.cliCommand} --version`,
        );
      }
    }

    return result.installedVersion ?? null;
  }
```

- [ ] **Step 6: Update `install.ts` to use the returned version in `src/cli/commands/install.ts`**

Replace lines 178–191 (the `if (versionToInstall …) … spinner.succeed(…)` block):

```ts
// Before (lines 178–191):
if (versionToInstall && agent.installVersion) {
  await agent.installVersion(versionToInstall);
} else {
  await agent.install();
}

// Restore CLI bin link if overwritten by agent package
await restoreCliBinLink();

// Get installed version for success message
const installedVersion = await agent.getVersion();
const installedVersionStr = installedVersion ? ` v${installedVersion}` : '';

spinner.succeed(`${agent.displayName}${installedVersionStr} installed successfully`);

// After:
let installedVersion: string | null = null;
if (versionToInstall && agent.installVersion) {
  installedVersion = await agent.installVersion(versionToInstall);
} else {
  await agent.install();
}

// Restore CLI bin link if overwritten by agent package
await restoreCliBinLink();

// Fall back to getVersion() only when installVersion() returned null
const displayVersion = installedVersion ?? await agent.getVersion();
const installedVersionStr = displayVersion ? ` v${displayVersion}` : '';

spinner.succeed(`${agent.displayName}${installedVersionStr} installed successfully`);
```

Also update the "newer than supported" warning at line 199 — change `installedVersion` to `displayVersion` so the check still runs when `installVersion()` returned null but getVersion found a version:

```ts
// Before (line 199):
if (installedVersion && agent.checkVersionCompatibility) {

// After:
if (displayVersion && agent.checkVersionCompatibility) {
```

- [ ] **Step 7: Run typecheck**

```
cd C:\Projects\codemie-dev\codemie-code
npm run typecheck
```

Expected: no errors. (KimiPlugin still returns `Promise<void>` from `installVersion()`, which is now a type error against the interface — fix that in Task 2.)

> If TypeScript reports an error on `kimi.plugin.ts` about the mismatched return type, that is expected and will be resolved in Task 2. You can add a `// @ts-ignore` on that line temporarily, or just proceed to Task 2 immediately.

- [ ] **Step 8: Run tests**

```
cd C:\Projects\codemie-dev\codemie-code
npx vitest run src/cli/commands/__tests__/install.version-selection.test.ts
```

Expected: all 3 tests PASS.
- "defaults codex installation…" passes (installVersion mock now returns `'0.129.0'`, spinner shows it)
- "uses the version returned by installVersion()…" passes (spinner shows `'2.1.34'` from mock, not stale `'2.1.33'`)
- "falls back to getVersion()…" passes (getVersion called, spinner shows `'2.1.34'`)

- [ ] **Step 9: Commit**

```bash
git add src/agents/core/types.ts \
        src/agents/core/BaseAgentAdapter.ts \
        src/agents/plugins/claude/claude.plugin.ts \
        src/cli/commands/install.ts \
        src/cli/commands/__tests__/install.version-selection.test.ts
git commit -m "fix(EPMCDME-10318): propagate verified version from installVersion() to success message

- AgentAdapter.installVersion() now returns Promise<string|null> instead of void
- ClaudePlugin.installVersion() returns result.installedVersion ?? null
- BaseAgentAdapter.installVersion() returns await this.getVersion() after npm install
- install.ts captures installVersion() return; falls back to getVersion() only when null
- ClaudePlugin.getVersion() adds shell:true to full-path exec to prevent stale-binary fallback
- Tests updated: primary path asserts installVersion() return is used; null-fallback path added"
```

---

### Task 2: Fix version propagation in the Kimi install path

**Files:**
- Modify: `src/agents/plugins/kimi/kimi.plugin.ts` (lines 176, 204, 222, 332, 369)
- Test: `src/agents/plugins/kimi/__tests__/kimi.plugin.test.ts`

**Interfaces:**
- Consumes: `AgentAdapter.installVersion?(): Promise<string | null>` (from Task 1)
- Produces: `KimiPlugin.installVersion()` returns `Promise<string | null>` — propagates `result.installedVersion ?? null` from the native install result
- Produces: `KimiPlugin.installNative()` returns `Promise<string | null>`

Test-first: yes — update 5 existing assertions from `.resolves.toBeUndefined()` to `.resolves.toBe('1.0.0')` (the value the `installNativeAgent` mock already returns).

- [ ] **Step 1: Update 5 assertions in `kimi.plugin.test.ts`**

The `installNativeAgent` mock at the top of the file already returns `{ success: true, installedVersion: '1.0.0', output: '' }`. After the fix, `installVersion()` will return `result.installedVersion ?? null` = `'1.0.0'`. Change each `.resolves.toBeUndefined()` to `.resolves.toBe('1.0.0')`:

```ts
// Line 48:
await expect(plugin.installVersion('supported')).resolves.toBe('1.0.0');

// Line 63:
await expect(plugin.installVersion('npm')).resolves.toBe('1.0.0');

// Line 78:
await expect(plugin.installVersion('latest')).resolves.toBe('1.0.0');

// Line 92:
await expect(plugin.installVersion('stable')).resolves.toBe('1.0.0');

// Line 119:
await expect(plugin.installVersion('1.2.3')).resolves.toBe('1.0.0');
```

The throws test at line 108 (`await expect(promise).rejects.toThrow(AgentInstallationError)`) does not change.

- [ ] **Step 2: Run kimi tests to confirm they fail**

```
cd C:\Projects\codemie-dev\codemie-code
npx vitest run src/agents/plugins/kimi/__tests__/kimi.plugin.test.ts
```

Expected: 5 tests FAIL with `Expected: '1.0.0' Received: undefined`.

- [ ] **Step 3: Change `installNative()` in `src/agents/plugins/kimi/kimi.plugin.ts`**

**Change 1 — `installNative()` return type (line 176):**

```ts
// Before:
private async installNative(version?: string): Promise<void> {

// After:
private async installNative(version?: string): Promise<string | null> {
```

**Change 2 — `installNative()` return value (line 204): add return after `logger.success` call, inside the try block, before the catch**

The try block contains: `const result = await installNativeAgent(...)`, `if (!result.success) throw ...`, and `logger.success(...)`. Add `return result.installedVersion ?? null;` after the `logger.success` line:

```ts
    try {
      const result = await installNativeAgent(
        this.metadata.name,
        this.metadata.installerUrls,
        version,
        {
          timeout: 300000,
          verifyCommand: this.metadata.cliCommand || undefined,
          verifyPath:
            process.platform === 'win32' ? undefined : resolveHomeDir(KIMI_NATIVE_BINARY_PATH),
        },
      );

      if (!result.success) {
        throw new AgentInstallationError(
          this.metadata.name,
          `Installation failed. Output: ${result.output}`,
        );
      }

      logger.success(`${this.metadata.displayName} installed successfully`);
      return result.installedVersion ?? null;
    } catch (error) {
```

The catch block always rethrows, so TypeScript is satisfied that all code paths return a value or throw.

- [ ] **Step 4: Change `installVersion()` in `src/agents/plugins/kimi/kimi.plugin.ts`**

**Change 1 — return type (line 332):**

```ts
// Before:
override async installVersion(version?: string): Promise<void> {

// After:
override async installVersion(version?: string): Promise<string | null> {
```

**Change 2 — propagate return value (line 368–369):**

```ts
// Before:
await this.installNative(resolvedVersion);

// After:
return await this.installNative(resolvedVersion);
```

- [ ] **Step 5: Fix `install()` override to not return a value (line 222)**

`install()` is declared `Promise<void>` but now calls `installVersion()` which returns `Promise<string | null>`. Remove the `return` to avoid a TypeScript type error:

```ts
// Before (line 222–224):
override async install(): Promise<void> {
    return this.installVersion(undefined);
}

// After:
override async install(): Promise<void> {
    await this.installVersion(undefined);
}
```

- [ ] **Step 6: Run kimi tests to confirm they pass**

```
cd C:\Projects\codemie-dev\codemie-code
npx vitest run src/agents/plugins/kimi/__tests__/kimi.plugin.test.ts
```

Expected: all 6 tests PASS.

- [ ] **Step 7: Run typecheck**

```
cd C:\Projects\codemie-dev\codemie-code
npm run typecheck
```

Expected: no errors.

- [ ] **Step 8: Run full test suite**

```
cd C:\Projects\codemie-dev\codemie-code
npx vitest run
```

Expected: all tests pass. Pay attention to any other tests in `claude/` or `install/` directories.

- [ ] **Step 9: Commit**

```bash
git add src/agents/plugins/kimi/kimi.plugin.ts \
        src/agents/plugins/kimi/__tests__/kimi.plugin.test.ts
git commit -m "fix(EPMCDME-10318): propagate verified version from KimiPlugin.installVersion()

- installNative() now returns Promise<string|null> instead of void
- installNative() returns result.installedVersion ?? null from NativeInstallResult
- installVersion() propagates the return value from installNative()
- install() updated to use await instead of return to match Promise<void> signature
- Kimi tests updated: installVersion() assertions now check for '1.0.0' (the mocked installedVersion)"
```
