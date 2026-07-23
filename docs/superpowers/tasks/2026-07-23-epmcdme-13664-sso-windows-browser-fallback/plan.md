# SSO Windows Browser Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix CodeMie CLI SSO on Windows by always printing the SSO URL as a manual fallback and using `explorer.exe` instead of `open()` to avoid the WDAC/AppLocker PowerShell dependency.

**Architecture:** Single method change in `CodeMieSSO.authenticate()` — print the SSO URL unconditionally before attempting to launch the browser, then branch on `process.platform === 'win32'` to use `spawn('explorer.exe', [ssoUrl], { detach: true, stdio: 'ignore' }).unref()` on Windows and `await open(ssoUrl)` elsewhere. No new files, no new dependencies.

**Tech Stack:** Node.js 20+, TypeScript (strict, ESM, NodeNext), Vitest, `child_process` (built-in), `open@^10.2.0`, `chalk`

## Global Constraints

- Node.js >= 20.0.0
- All imports use `.js` extension (ESM/NodeNext)
- Platform detection: `process.platform === 'win32'` (no import needed) — consistent with `src/agents/` and `src/mcp/` convention; do NOT use `os.platform()`
- No new npm dependencies
- Commit scope: `fix(providers):`
- Test runner: `npx vitest run` (not `npm test` — that runs the full suite)

---

### Task 1: Write failing tests and implement browser-launch fix in `sso.auth.ts`

**Test-first: yes — three failing tests asserting URL is printed and the correct launcher is called per platform**

**Files:**
- Modify: `src/providers/plugins/sso/sso.auth.ts` (lines 108–111, the browser launch block)
- Modify: `src/providers/plugins/sso/__tests__/sso.auth.test.ts` (append new `describe` block; update top-level imports)

**Interfaces:**
- Consumes: `CodeMieSSO.authenticate(config: SSOAuthConfig): Promise<SSOAuthResult>` — public API; signature unchanged
- Produces: Same method now additionally: (1) logs the SSO URL to stdout before every launch attempt; (2) spawns `explorer.exe` on Windows; (3) calls `open()` on macOS/Linux as before

---

- [ ] **Step 1: Update the top-level imports in the test file**

Open `src/providers/plugins/sso/__tests__/sso.auth.test.ts`. Replace line 5 (the existing vitest import) and line 6 (the deriveExpiresAt import) with the expanded block below. The rest of the file stays exactly as-is.

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import open from 'open';
import { spawn } from 'child_process';
import { deriveExpiresAt } from '../sso.auth.js';

vi.mock('open', () => ({
  default: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: vi.fn(() => ({ unref: vi.fn() })),
  };
});
```

The `vi.mock` calls are hoisted by Vitest to before any imports, so placement here is cosmetic — they take effect before any module loads.

---

- [ ] **Step 2: Append the three failing tests**

At the bottom of `src/providers/plugins/sso/__tests__/sso.auth.test.ts`, after the closing `});` of the existing `deriveExpiresAt` describe block, append:

```ts
describe('CodeMieSSO.authenticate() — browser launch', () => {
  let originalPlatform: NodeJS.Platform;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalPlatform = process.platform;
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(open).mockClear();
    vi.mocked(spawn).mockClear();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    consoleSpy.mockRestore();
  });

  it('prints the SSO URL to console before browser launch on any platform', async () => {
    const { CodeMieSSO } = await import('../sso.auth.js');
    const sso = new CodeMieSSO();

    // timeout: 50 causes authenticate() to time out quickly after launching the browser
    await sso.authenticate({ codeMieUrl: 'https://example.com', timeout: 50 });

    const output = consoleSpy.mock.calls.map(args => String(args[0])).join('\n');
    expect(output).toContain('https://example.com/v1/auth/login/');
  });

  it('spawns explorer.exe on Windows and does not call open()', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const { CodeMieSSO } = await import('../sso.auth.js');
    const sso = new CodeMieSSO();

    await sso.authenticate({ codeMieUrl: 'https://example.com', timeout: 50 });

    expect(spawn).toHaveBeenCalledWith(
      'explorer.exe',
      [expect.stringContaining('/v1/auth/login/')],
      expect.objectContaining({ detach: true, stdio: 'ignore' }),
    );
    expect(open).not.toHaveBeenCalled();
  });

  it('calls open() on macOS and does not spawn explorer.exe', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const { CodeMieSSO } = await import('../sso.auth.js');
    const sso = new CodeMieSSO();

    await sso.authenticate({ codeMieUrl: 'https://example.com', timeout: 50 });

    expect(open).toHaveBeenCalledWith(expect.stringContaining('/v1/auth/login/'));
    expect(spawn).not.toHaveBeenCalled();
  });
});
```

> **Why `timeout: 50`?** `authenticate()` starts a real local HTTP server, launches the browser (mocked), then waits for an OAuth callback. With a 50ms timeout it returns `{ success: false, error: 'Authentication timeout...' }` almost instantly — the browser-launch mocks are still called before the wait, so the assertions are valid. The server is closed in the `finally` block, so no handles leak.

---

- [ ] **Step 3: Run the three new tests — verify they FAIL**

```bash
npx vitest run src/providers/plugins/sso/__tests__/sso.auth.test.ts --reporter=verbose
```

Expected: The three `CodeMieSSO.authenticate()` tests FAIL. Typical failure messages:
- "prints SSO URL" → expected `output` to contain `'https://example.com/v1/auth/login/'` but it did not
- "spawns explorer.exe on Windows" → `spawn` was not called / `open` was called
- "calls open() on macOS" → `open` was not called

The existing three `deriveExpiresAt` tests should still PASS.

---

- [ ] **Step 4: Implement the fix in `sso.auth.ts`**

Open `src/providers/plugins/sso/sso.auth.ts`. Find the browser launch block (currently lines 108–111). Replace it with:

```ts
      // 3. Launch browser
      console.log(chalk.white(`Opening browser for authentication...`));
      // Always print the SSO URL — open() silently exits under WDAC/AppLocker without throwing,
      // so a catch-block fallback would never fire on affected corporate machines.
      console.log(chalk.cyan(`\nIf the browser doesn't open, navigate to this URL manually:\n${ssoUrl}\n`));

      if (process.platform === 'win32') {
        // Use explorer.exe directly — avoids powershell.exe Start-Process which WDAC/AppLocker
        // can block on corporate machines. open npm v10+ always delegates to PowerShell on Windows.
        // Note: mcp-oauth-provider.ts chose PowerShell over cmd /c start to preserve URL
        // query-string characters; explorer.exe via spawn avoids both PowerShell and CMD entirely.
        const { spawn } = await import('child_process');
        spawn('explorer.exe', [ssoUrl], { detach: true, stdio: 'ignore' }).unref();
      } else {
        await open(ssoUrl);
      }
```

The surrounding code (step 2 above and step 4 below — `startLocalServer` and `waitForCallback`) is unchanged.

---

- [ ] **Step 5: Run the three new tests — verify they PASS**

```bash
npx vitest run src/providers/plugins/sso/__tests__/sso.auth.test.ts --reporter=verbose
```

Expected: All 6 tests pass (3 existing `deriveExpiresAt` + 3 new browser-launch tests).

---

- [ ] **Step 6: Run the full unit test suite**

```bash
npm run test:unit
```

Expected: All tests pass, zero regressions.

---

- [ ] **Step 7: Typecheck and lint**

```bash
npm run typecheck && npm run lint
```

Expected: No errors, no warnings.

---

- [ ] **Step 8: Commit**

```bash
git add src/providers/plugins/sso/sso.auth.ts \
        src/providers/plugins/sso/__tests__/sso.auth.test.ts
git commit -m "fix(providers): print SSO URL fallback and use explorer.exe on Windows

On Windows, open npm v10+ delegates browser launch to powershell.exe
Start-Process which WDAC/AppLocker can block on corporate machines.
Replace with spawn('explorer.exe') which is WDAC-whitelisted.
Always print the SSO URL before the launch attempt so users can
complete auth manually if the browser does not open.

Fixes EPMCDME-13664."
```
