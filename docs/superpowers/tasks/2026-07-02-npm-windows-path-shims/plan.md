# npm Windows PATH / bin shims fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `scripts/postinstall.mjs` so `npm install -g @codemieai/code` correctly detects npm's Windows global prefix and persists it to the Windows user PATH, so `codemie` resolves after install (including for non-interactive bash hook subprocesses), while leaving Unix behavior unchanged.

**Architecture:** Refactor the currently side-effect-only, zero-export `postinstall.mjs` into small exported functions gated behind a direct-execution guard. Add a Windows branch (`runWindows`) that detects npm's real prefix (no `bin/` join), warns (non-fatal) if expected shim files are missing, and reuses the already-tested `dist/utils/windows-path.js` (`isInUserPath`/`addToUserPath`) for registry-backed PATH persistence — exiting 1 only if that persistence call itself fails. The existing Unix branch (`runUnix`) keeps its current logic, with the hardcoded `:` PATH separator replaced by `path.delimiter`.

**Tech Stack:** Node.js ESM (`.mjs`), Vitest, existing `src/utils/windows-path.ts` (compiled to `dist/utils/windows-path.js`).

---

## File structure

- **Modify:** `scripts/postinstall.mjs` — refactor into exported functions + platform branch (see spec: `docs/superpowers/tasks/2026-07-02-npm-windows-path-shims/spec.md`)
- **Create:** `scripts/__tests__/postinstall.test.ts` — new test file, built incrementally task-by-task
- **Modify:** `vitest.config.ts` — add `scripts/**/*.test.ts` to `test.include`

No other files change. `src/utils/windows-path.ts` / `dist/utils/windows-path.js` are consumed as-is, not modified.

---

### Task 1: Enable `scripts/` tests in Vitest

**Files:**
- Modify: `vitest.config.ts:7`

**Test-first: no** — this is a test-runner config change; there is no independent unit test for "does vitest.config.ts include the right glob." Task 2 will prove this works by being the first test that must actually run.

- [ ] **Step 1: Update `test.include`**

In `vitest.config.ts`, change:

```ts
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts', 'tests/**/*.test.ts'],
```

to:

```ts
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts', 'tests/**/*.test.ts', 'scripts/**/*.test.ts'],
```

- [ ] **Step 2: Commit**

```bash
git add vitest.config.ts
git commit -m "chore(deps): include scripts/**/*.test.ts in vitest test glob"
```

---

### Task 2: `getNpmPrefix()` and `getShimDir()` — the core Windows detection fix

**Files:**
- Create: `scripts/__tests__/postinstall.test.ts`
- Modify: `scripts/postinstall.mjs` (full rewrite starts here, built up task by task)

**Test-first: yes — "getShimDir returns the prefix itself on win32 (no bin/ join), and prefix/bin on other platforms"**

- [ ] **Step 1: Write the failing test**

Create `scripts/__tests__/postinstall.test.ts` with the mock scaffolding the whole file will reuse, plus the first two test cases:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';

vi.mock('node:child_process', () => ({
	execSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
	existsSync: vi.fn(),
	readFileSync: vi.fn(),
	appendFileSync: vi.fn(),
}));

vi.mock('../../dist/utils/windows-path.js', () => ({
	isInUserPath: vi.fn(),
	addToUserPath: vi.fn(),
}));

describe('postinstall', () => {
	const originalPlatform = process.platform;
	const originalExitCode = process.exitCode;

	beforeEach(() => {
		vi.mocked(execSync).mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		Object.defineProperty(process, 'platform', {
			value: originalPlatform,
			configurable: true,
		});
		process.exitCode = originalExitCode;
	});

	describe('getNpmPrefix', () => {
		it('returns the trimmed npm prefix on success', async () => {
			vi.mocked(execSync).mockReturnValue('C:\\Users\\Test\\AppData\\Roaming\\npm\n' as unknown as Buffer);

			const { getNpmPrefix } = await import('../postinstall.mjs');
			const result = getNpmPrefix();

			expect(result).toBe('C:\\Users\\Test\\AppData\\Roaming\\npm');
			expect(execSync).toHaveBeenCalledWith(
				'npm config get prefix',
				{ encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
			);
		});

		it('returns null if npm is unavailable', async () => {
			vi.mocked(execSync).mockImplementation(() => {
				throw new Error('command not found');
			});

			const { getNpmPrefix } = await import('../postinstall.mjs');
			const result = getNpmPrefix();

			expect(result).toBeNull();
		});
	});

	describe('getShimDir', () => {
		it('returns the prefix directly on win32 (no bin/ join)', async () => {
			const { getShimDir } = await import('../postinstall.mjs');
			const result = getShimDir('C:\\Users\\Test\\AppData\\Roaming\\npm', 'win32');

			expect(result).toBe('C:\\Users\\Test\\AppData\\Roaming\\npm');
		});

		it('returns prefix/bin on non-win32 platforms', async () => {
			const { getShimDir } = await import('../postinstall.mjs');
			const result = getShimDir('/usr/local', 'darwin');

			expect(result).toBe('/usr/local/bin');
		});
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/__tests__/postinstall.test.ts`
Expected: FAIL — `scripts/postinstall.mjs` has no exports today, so `import('../postinstall.mjs')` will not provide `getNpmPrefix`/`getShimDir` (they are `undefined`, calling them throws `TypeError: getNpmPrefix is not a function`).

- [ ] **Step 3: Write minimal implementation**

Replace the full contents of `scripts/postinstall.mjs` with:

```js
#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { platform } from 'node:os';
import { posix as pathPosix } from 'node:path';

export function getNpmPrefix() {
	try {
		return execSync('npm config get prefix', {
			encoding: 'utf8',
			stdio: ['pipe', 'pipe', 'ignore'],
		}).trim();
	} catch {
		return null;
	}
}

export function getShimDir(prefix, plat = platform()) {
	// posix.join (not the OS-native join) so this stays correct — and testable —
	// regardless of which OS this script itself runs on; native `join` always
	// matches the real host OS, not the `plat` parameter, which breaks simulating
	// a non-win32 platform from a Windows dev/CI machine.
	return plat === 'win32' ? prefix : pathPosix.join(prefix, 'bin');
}
```

(The rest of the module — `isInPath`, `getShellRcFile`, `alreadyInRcFile`, shim verification, `runWindows`/`runUnix`/`run`, and the direct-execution guard — is added in the following tasks, along with the additional imports each one needs. Task 4 introduces the OS-native `join` (distinct from this task's `pathPosix.join`) for real filesystem paths on the actual host OS. Importing symbols before they're used would trip the `no-unused-vars` lint rule at this task's commit, so imports grow incrementally task-by-task rather than all appearing here. The old top-level side-effecting statements are removed now; nothing runs yet when the file is executed directly until Task 7 restores that behavior.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/__tests__/postinstall.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/postinstall.mjs scripts/__tests__/postinstall.test.ts
git commit -m "refactor(cli): export getNpmPrefix/getShimDir, fix Windows shim dir detection"
```

---

### Task 3: `isInPath()`, `getShellRcFile()`, `alreadyInRcFile()` — export the Unix helpers

**Test-first: yes — "isInPath splits PATH on path.delimiter (`;` on win32, `:` elsewhere)"**

- [ ] **Step 1: Write the failing test**

Add to `scripts/__tests__/postinstall.test.ts`, inside the `describe('postinstall', ...)` block, after the `getShimDir` describe block:

```ts
	describe('isInPath', () => {
		const originalPath = process.env.PATH;

		afterEach(() => {
			process.env.PATH = originalPath;
		});

		it('detects a directory using ";" on win32', async () => {
			process.env.PATH = 'C:\\Windows;C:\\Users\\Test\\AppData\\Roaming\\npm;C:\\Windows\\System32';

			const { isInPath } = await import('../postinstall.mjs');
			expect(isInPath('C:\\Users\\Test\\AppData\\Roaming\\npm')).toBe(true);
			expect(isInPath('C:\\Nonexistent')).toBe(false);
		});

		it('detects a directory using ":" on unix', async () => {
			process.env.PATH = '/usr/local/bin:/usr/local/lib/node/bin:/usr/bin';

			const { isInPath } = await import('../postinstall.mjs');
			expect(isInPath('/usr/local/lib/node/bin')).toBe(true);
			expect(isInPath('/nonexistent')).toBe(false);
		});
	});

	describe('getShellRcFile', () => {
		const originalShell = process.env.SHELL;

		afterEach(() => {
			process.env.SHELL = originalShell;
		});

		it('returns .zshrc when SHELL contains zsh', async () => {
			process.env.SHELL = '/bin/zsh';

			const { getShellRcFile } = await import('../postinstall.mjs');
			expect(getShellRcFile()).toMatch(/\.zshrc$/);
		});

		it('returns .bash_profile when it exists and SHELL contains bash', async () => {
			process.env.SHELL = '/bin/bash';
			vi.mocked(existsSync).mockReturnValue(true);

			const { getShellRcFile } = await import('../postinstall.mjs');
			expect(getShellRcFile()).toMatch(/\.bash_profile$/);
		});

		it('returns .bashrc when .bash_profile does not exist and SHELL contains bash', async () => {
			process.env.SHELL = '/bin/bash';
			vi.mocked(existsSync).mockReturnValue(false);

			const { getShellRcFile } = await import('../postinstall.mjs');
			expect(getShellRcFile()).toMatch(/\.bashrc$/);
		});

		it('returns null when SHELL is unset (Windows)', async () => {
			delete process.env.SHELL;

			const { getShellRcFile } = await import('../postinstall.mjs');
			expect(getShellRcFile()).toBeNull();
		});
	});

	describe('alreadyInRcFile', () => {
		it('returns false when the rc file does not exist', async () => {
			vi.mocked(existsSync).mockReturnValue(false);

			const { alreadyInRcFile } = await import('../postinstall.mjs');
			expect(alreadyInRcFile('/home/user/.bashrc', '/usr/local/bin')).toBe(false);
		});

		it('returns true when the rc file already contains the dir', async () => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFileSync).mockReturnValue('export PATH="/usr/local/bin:$PATH"\n');

			const { alreadyInRcFile } = await import('../postinstall.mjs');
			expect(alreadyInRcFile('/home/user/.bashrc', '/usr/local/bin')).toBe(true);
		});
	});
```

Add `existsSync` and `readFileSync` to the test file's top-level import from `node:fs`:

```ts
import { existsSync, readFileSync } from 'node:fs';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/__tests__/postinstall.test.ts`
Expected: FAIL — `isInPath`, `getShellRcFile`, `alreadyInRcFile` are not exported yet.

- [ ] **Step 3: Write minimal implementation**

Update the imports at the top of `scripts/postinstall.mjs`:

```js
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, delimiter, posix as pathPosix } from 'node:path';
```

Append to `scripts/postinstall.mjs` (after `getShimDir`). Note: like `getShimDir`'s `plat` parameter, `isInPath` takes an optional `sep` parameter (defaulting to the real `path.delimiter`) so both branches are deterministically testable regardless of host OS — otherwise `path.delimiter` always reflects the actual machine running the test, not the platform under test:

```js
export function isInPath(dir) {
	return (process.env.PATH ?? '').split(delimiter).includes(dir);
}

export function getShellRcFile() {
	const shell = process.env.SHELL ?? '';
	const home = homedir();
	if (shell.includes('zsh')) return join(home, '.zshrc');
	if (shell.includes('bash')) {
		const bashProfile = join(home, '.bash_profile');
		return existsSync(bashProfile) ? bashProfile : join(home, '.bashrc');
	}
	return null;
}

export function alreadyInRcFile(rcFile, dir) {
	if (!existsSync(rcFile)) return false;
	return readFileSync(rcFile, 'utf8').includes(dir);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/__tests__/postinstall.test.ts`
Expected: PASS (all tests so far)

- [ ] **Step 5: Commit**

```bash
git add scripts/postinstall.mjs scripts/__tests__/postinstall.test.ts
git commit -m "refactor(cli): export isInPath/getShellRcFile/alreadyInRcFile with path.delimiter fix"
```

---

### Task 4: `getExpectedShimNames()` and `findMissingShims()` — shim verification diagnostic

**Test-first: yes — "findMissingShims returns names whose .cmd file is absent from the directory"**

- [ ] **Step 1: Write the failing test**

Add to `scripts/__tests__/postinstall.test.ts`:

```ts
	describe('getExpectedShimNames', () => {
		it('returns the keys of package.json bin field', async () => {
			vi.mocked(readFileSync).mockReturnValue(
				JSON.stringify({ bin: { codemie: './bin/codemie.js', 'codemie-claude': './bin/codemie-claude.js' } })
			);

			const { getExpectedShimNames } = await import('../postinstall.mjs');
			expect(getExpectedShimNames()).toEqual(['codemie', 'codemie-claude']);
		});
	});

	describe('findMissingShims', () => {
		it('returns names whose .cmd file does not exist in dir', async () => {
			vi.mocked(existsSync).mockImplementation((p) => !String(p).includes('codemie-claude.cmd'));

			const { findMissingShims } = await import('../postinstall.mjs');
			const result = findMissingShims('C:\\npm', ['codemie', 'codemie-claude']);

			expect(result).toEqual(['codemie-claude']);
		});

		it('returns an empty array when all shims exist', async () => {
			vi.mocked(existsSync).mockReturnValue(true);

			const { findMissingShims } = await import('../postinstall.mjs');
			const result = findMissingShims('C:\\npm', ['codemie', 'codemie-claude']);

			expect(result).toEqual([]);
		});
	});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/__tests__/postinstall.test.ts`
Expected: FAIL — `getExpectedShimNames`, `findMissingShims` are not exported yet.

- [ ] **Step 3: Write minimal implementation**

Update the `node:path` import and add a new `node:url` import at the top of `scripts/postinstall.mjs`:

```js
import { join, delimiter, dirname, posix as pathPosix } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
```

Append to `scripts/postinstall.mjs` (after `alreadyInRcFile`):

```js
export function getExpectedShimNames() {
	const packageJsonPath = join(__dirname, '..', 'package.json');
	const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
	return Object.keys(pkg.bin ?? {});
}

export function findMissingShims(dir, names) {
	return names.filter((name) => !existsSync(join(dir, `${name}.cmd`)));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/__tests__/postinstall.test.ts`
Expected: PASS (all tests so far)

- [ ] **Step 5: Commit**

```bash
git add scripts/postinstall.mjs scripts/__tests__/postinstall.test.ts
git commit -m "feat(cli): add missing-shim diagnostic for Windows postinstall"
```

---

### Task 5: `runWindows()` — PATH persistence via `dist/utils/windows-path.js`

**Test-first: yes — "runWindows adds the shim dir to PATH when not already present, and exits 1 only when addToUserPath fails"**

- [ ] **Step 1: Write the failing test**

Add to `scripts/__tests__/postinstall.test.ts`. First add the `isInUserPath`/`addToUserPath` mock import at the top:

```ts
import { isInUserPath, addToUserPath } from '../../dist/utils/windows-path.js';
```

Then add the describe block:

```ts
	describe('runWindows', () => {
		beforeEach(() => {
			vi.mocked(execSync).mockReturnValue('C:\\Users\\Test\\AppData\\Roaming\\npm\n' as unknown as Buffer);
			vi.mocked(existsSync).mockReturnValue(true); // all shims present by default
		});

		it('does nothing if npm prefix cannot be determined', async () => {
			vi.mocked(execSync).mockImplementation(() => {
				throw new Error('npm not found');
			});

			const { runWindows } = await import('../postinstall.mjs');
			await runWindows();

			expect(isInUserPath).not.toHaveBeenCalled();
			expect(process.exitCode).toBeFalsy();
		});

		it('is a no-op when the shim dir is already in PATH', async () => {
			vi.mocked(isInUserPath).mockResolvedValue(true);

			const { runWindows } = await import('../postinstall.mjs');
			await runWindows();

			expect(addToUserPath).not.toHaveBeenCalled();
			expect(process.exitCode).toBeFalsy();
		});

		it('adds the shim dir to PATH when missing, and does not set a failing exit code', async () => {
			vi.mocked(isInUserPath).mockResolvedValue(false);
			vi.mocked(addToUserPath).mockResolvedValue({ success: true, pathAdded: 'C:\\Users\\Test\\AppData\\Roaming\\npm', requiresRestart: true, alreadyInPath: false });

			const { runWindows } = await import('../postinstall.mjs');
			await runWindows();

			expect(addToUserPath).toHaveBeenCalledWith('C:\\Users\\Test\\AppData\\Roaming\\npm');
			expect(process.exitCode).toBeFalsy();
		});

		it('sets exitCode 1 and prints manual instructions when addToUserPath fails', async () => {
			vi.mocked(isInUserPath).mockResolvedValue(false);
			vi.mocked(addToUserPath).mockResolvedValue({ success: false, error: 'setx failed: access denied', requiresRestart: false, alreadyInPath: false });
			const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			const { runWindows } = await import('../postinstall.mjs');
			await runWindows();

			expect(process.exitCode).toBe(1);
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('setx failed: access denied'));
		});

		it('warns but does not fail when expected shim files are missing', async () => {
			vi.mocked(existsSync).mockReturnValue(false); // no shims found
			vi.mocked(isInUserPath).mockResolvedValue(true);
			vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ bin: { codemie: './bin/codemie.js' } }));
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

			const { runWindows } = await import('../postinstall.mjs');
			await runWindows();

			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('codemie'));
			expect(process.exitCode).toBeFalsy();
		});
	});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/__tests__/postinstall.test.ts`
Expected: FAIL — `runWindows` is not exported yet.

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/postinstall.mjs` (after `findMissingShims`):

```js
export async function runWindows() {
	const prefix = getNpmPrefix();
	if (!prefix) return;

	const dir = getShimDir(prefix, 'win32');

	const missing = findMissingShims(dir, getExpectedShimNames());
	if (missing.length > 0) {
		console.warn(`\n⚠️  Expected CodeMie command shims not found in ${dir}: ${missing.join(', ')}\n`);
	}

	const { isInUserPath, addToUserPath } = await import('../dist/utils/windows-path.js');

	if (await isInUserPath(dir)) return;

	const result = await addToUserPath(dir);
	if (result.success) {
		console.log(`\n✓ Added ${dir} to PATH\n  Open a new terminal to use codemie\n`);
		return;
	}

	console.error(`\n✗ Could not update PATH automatically: ${result.error}`);
	console.error(`  Add manually: setx PATH "%PATH%;${dir}"`);
	console.error(`  (or via System Properties > Environment Variables)\n`);
	process.exitCode = 1;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/__tests__/postinstall.test.ts`
Expected: PASS (all tests so far)

- [ ] **Step 5: Commit**

```bash
git add scripts/postinstall.mjs scripts/__tests__/postinstall.test.ts
git commit -m "feat(cli): add runWindows — persist npm shim dir to Windows user PATH"
```

---

### Task 6: `runUnix()` — wrap the existing Unix logic

**Test-first: yes — "runUnix appends to the rc file when the shim dir is missing from PATH, and is a no-op when already present or already recorded"**

- [ ] **Step 1: Write the failing test**

Add `appendFileSync` to the test file's `node:fs` import:

```ts
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
```

Add to `scripts/__tests__/postinstall.test.ts`:

```ts
	describe('runUnix', () => {
		beforeEach(() => {
			vi.mocked(execSync).mockReturnValue('/usr/local\n' as unknown as Buffer);
			process.env.PATH = '/usr/bin:/bin';
			process.env.SHELL = '/bin/bash';
		});

		it('does nothing if npm prefix cannot be determined', async () => {
			vi.mocked(execSync).mockImplementation(() => {
				throw new Error('npm not found');
			});

			const { runUnix } = await import('../postinstall.mjs');
			runUnix();

			expect(appendFileSync).not.toHaveBeenCalled();
		});

		it('is a no-op when the shim dir is already in PATH', async () => {
			process.env.PATH = '/usr/local/bin:/usr/bin:/bin';

			const { runUnix } = await import('../postinstall.mjs');
			runUnix();

			expect(appendFileSync).not.toHaveBeenCalled();
		});

		it('is a no-op when the rc file already contains the dir', async () => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFileSync).mockReturnValue('export PATH="/usr/local/bin:$PATH"\n');

			const { runUnix } = await import('../postinstall.mjs');
			runUnix();

			expect(appendFileSync).not.toHaveBeenCalled();
		});

		it('appends to the rc file when the dir is missing from PATH and not already recorded', async () => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFileSync).mockReturnValue('# existing rc contents\n');

			const { runUnix } = await import('../postinstall.mjs');
			runUnix();

			expect(appendFileSync).toHaveBeenCalledWith(
				expect.stringContaining('.bash_profile'),
				expect.stringContaining('/usr/local/bin')
			);
		});
	});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/__tests__/postinstall.test.ts`
Expected: FAIL — `runUnix` is not exported yet.

- [ ] **Step 3: Write minimal implementation**

Update the `node:fs` import at the top of `scripts/postinstall.mjs` to add `appendFileSync`:

```js
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
```

Append to `scripts/postinstall.mjs` (after `runWindows`). Note: `runUnix` takes an optional `plat` parameter (defaulting to the real `platform()`), same rationale as `getShimDir`'s `plat` and `isInPath`'s `sep` — otherwise `platform()` always reflects the real host OS regardless of which branch a test is exercising. The separator passed to `isInPath` is derived from `plat` for the same reason:

```js
export function runUnix(plat = platform()) {
	const prefix = getNpmPrefix();
	if (!prefix) return;

	const npmBin = getShimDir(prefix, plat);
	if (isInPath(npmBin, plat === 'win32' ? ';' : ':')) return;

	const rcFile = getShellRcFile();
	if (!rcFile) {
		console.log(`\n⚠️  Add to PATH manually:\n   export PATH="${npmBin}:$PATH"\n`);
		return;
	}

	if (alreadyInRcFile(rcFile, npmBin)) return;

	appendFileSync(rcFile, `\n# Added by @codemieai/code\nexport PATH="${npmBin}:$PATH"\n`);

	console.log(`\n✓ Added ${npmBin} to PATH in ${rcFile}`);
	console.log(`  Run: source ${rcFile}\n`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/__tests__/postinstall.test.ts`
Expected: PASS (all tests so far)

- [ ] **Step 5: Commit**

```bash
git add scripts/postinstall.mjs scripts/__tests__/postinstall.test.ts
git commit -m "refactor(cli): wrap existing unix PATH logic into runUnix"
```

---

### Task 7: `run()` and the direct-execution guard

**Test-first: yes — "run() dispatches to runWindows on win32 and runUnix otherwise"**

- [ ] **Step 1: Write the failing test**

Add to `scripts/__tests__/postinstall.test.ts`. Note: `vi.spyOn(mod, 'runWindows')` does **not** intercept `run()`'s internal call to `runWindows` — ESM same-module calls bind directly to the local function, not through the mutable export namespace object, so spying on the export is a no-op for this purpose. Test the actual dispatched behavior instead (which is what matters anyway):

```ts
	describe('run', () => {
		it('dispatches to the windows PATH mechanism (registry) on win32, not the rc-file mechanism', async () => {
			Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
			vi.mocked(execSync).mockReturnValue('C:\\Users\\Test\\AppData\\Roaming\\npm\n' as unknown as Buffer);
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(isInUserPath).mockResolvedValue(false);
			vi.mocked(addToUserPath).mockResolvedValue({
				success: true,
				pathAdded: 'C:\\Users\\Test\\AppData\\Roaming\\npm',
				requiresRestart: true,
				alreadyInPath: false,
			});

			const { run } = await import('../postinstall.mjs');
			await run();

			expect(addToUserPath).toHaveBeenCalled();
			expect(appendFileSync).not.toHaveBeenCalled();
		});

		it('dispatches to the rc-file mechanism on non-win32 platforms, not the windows PATH mechanism', async () => {
			Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
			vi.mocked(execSync).mockReturnValue('/usr/local\n' as unknown as Buffer);
			process.env.PATH = '/usr/bin:/bin';
			process.env.SHELL = '/bin/bash';
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFileSync).mockReturnValue('# existing rc contents\n');

			const { run } = await import('../postinstall.mjs');
			await run();

			expect(appendFileSync).toHaveBeenCalled();
			expect(isInUserPath).not.toHaveBeenCalled();
			expect(addToUserPath).not.toHaveBeenCalled();
		});
	});
```

**Mock isolation note:** by this point the test file has several module-level mocks (`execSync`, `existsSync`, `readFileSync`, `appendFileSync`, `isInUserPath`, `addToUserPath`) whose call history and return values persist across tests unless explicitly cleared — `vi.restoreAllMocks()` in the top-level `afterEach` does not reliably reset factory-created `vi.fn()` mocks (only real `vi.spyOn` spies). The top-level `beforeEach` must explicitly `mockClear()`/`mockReset()` each of these, and give `readFileSync` a safe default valid-JSON return (since `runWindows` always calls `getExpectedShimNames()`, which `JSON.parse`s it, even in tests that don't care about shim names). Without this, tests pass or fail depending on execution order rather than their own setup — add these resets now if they weren't already added incrementally in earlier tasks:

```ts
	beforeEach(() => {
		vi.mocked(execSync).mockReset();
		vi.mocked(isInUserPath).mockClear();
		vi.mocked(addToUserPath).mockClear();
		vi.mocked(appendFileSync).mockClear();
		vi.mocked(existsSync).mockReset();
		vi.mocked(readFileSync).mockReset();
		vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ bin: { codemie: './bin/codemie.js' } }));
	});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/__tests__/postinstall.test.ts`
Expected: FAIL — `run` is not exported yet.

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/postinstall.mjs` (after `runUnix`):

```js
export async function run() {
	if (platform() === 'win32') {
		await runWindows();
	} else {
		runUnix();
	}
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
	await run();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/__tests__/postinstall.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/postinstall.mjs scripts/__tests__/postinstall.test.ts
git commit -m "feat(cli): add run() dispatcher and direct-execution guard to postinstall.mjs"
```

---

### Task 8: Full verification pass

**Test-first: no** — this task runs the full existing suites to confirm no regressions; it doesn't add new behavior of its own.

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS — all existing `src/**` and `tests/**` tests plus the new `scripts/__tests__/postinstall.test.ts` suite.

- [ ] **Step 2: Run lint and typecheck**

Run: `npm run lint && npm run typecheck`
Expected: PASS. (`postinstall.mjs` is plain JS, not part of `tsconfig.json`'s `include` — confirm `npm run typecheck` doesn't attempt to type-check it; if it does, no action needed since the file has no TS syntax errors, but if `eslint` flags anything in the new file, fix inline.)

- [ ] **Step 3: Manually sanity-check the exported shape**

Run: `node --input-type=module -e "const m = await import('./scripts/postinstall.mjs'); console.log(Object.keys(m))"`
Expected output includes: `getNpmPrefix, getShimDir, isInPath, getShellRcFile, alreadyInRcFile, getExpectedShimNames, findMissingShims, runWindows, runUnix, run`

- [ ] **Step 4: Commit (if any fixups were needed)**

```bash
git add -A
git commit -m "chore: fixups from full verification pass" --allow-empty-message -m "fixups from lint/typecheck" 2>/dev/null || true
```

(Only commit if Steps 2-3 required changes; otherwise skip — there's nothing to commit.)
