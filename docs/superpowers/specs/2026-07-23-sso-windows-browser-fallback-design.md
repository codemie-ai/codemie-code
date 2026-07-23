# SSO Windows Browser Fallback — Design

**Ticket**: EPMCDME-13664  
**Branch**: EPMCDME-13664_sso-windows-browser-fallback  
**Date**: 2026-07-23

---

## Problem

During `codemie setup`, selecting CodeMie SSO opens a local callback server and launches a browser-based auth flow. On Windows, `open` npm v10+ launches the browser via:

```
powershell.exe -EncodedCommand "Start <url>"
```

On corporate Windows machines with WDAC/AppLocker endpoint protection, `powershell.exe` may be blocked or the `Microsoft.PowerShell.Management` module unavailable. `open()` exits silently — no exception is thrown, no browser opens. The CLI prints no fallback URL and waits 120 seconds before failing with:

```
Authentication timeout - no response received
```

The user has no recovery path.

---

## Goal

1. Always print the SSO URL in the terminal before attempting to launch the browser, so the user can always complete auth manually.
2. On Windows, launch the browser via `explorer.exe` directly (no PowerShell dependency).
3. Leave macOS and Linux behavior unchanged.

---

## Non-Goals

- Configurable timeout (hardcoded 120 s in three places — separate chore)
- Consolidating `browser.ts` with the new OS-conditional logic (pre-existing inconsistency — separate chore)
- WSL-specific handling beyond what `process.platform` already provides

---

## Affected File

`src/providers/plugins/sso/sso.auth.ts` — `CodeMieSSO.authenticate()`, replacing ~2 lines around line 110.

No other source files require changes.

---

## Design

### URL Print (unconditional)

Print the SSO URL **before** the browser launch attempt. A catch-block fallback is not viable because `open()` v10+ silently exits under WDAC without throwing.

```ts
console.log(chalk.white(`Opening browser for authentication...`));
console.log(chalk.cyan(`\nIf the browser doesn't open, navigate to this URL manually:\n${ssoUrl}\n`));
```

### Platform-Conditional Browser Launch

```ts
if (process.platform === 'win32') {
  // Use explorer.exe directly — avoids powershell.exe Start-Process which WDAC/AppLocker
  // can block on corporate machines (open npm v10+ always delegates to PowerShell on Windows).
  // Note: mcp-oauth-provider.ts deliberately chose PowerShell over cmd /c start to preserve
  // URL query-string characters; explorer.exe via spawn is a third path that avoids both
  // PowerShell and CMD entirely, making it safe under WDAC/AppLocker.
  const { spawn } = await import('child_process');
  spawn('explorer.exe', [ssoUrl], { detach: true, stdio: 'ignore' }).unref();
} else {
  await open(ssoUrl);
}
```

**Why `explorer.exe`:**
- Part of Windows Shell; virtually always WDAC-whitelisted on corporate machines
- Does not invoke `powershell.exe` or `cmd.exe`
- Passes the URL directly to the registered default browser handler
- Preserves URL query-string characters (no CMD metacharacter splitting)

**Why `spawn().unref()`:**
- Fire-and-forget; the CLI does not wait on the browser process
- `{ detach: true, stdio: 'ignore' }` lets the browser outlive the CLI process cleanly

**Platform detection:** `process.platform === 'win32'` — consistent with `src/agents/` and `src/mcp/` convention; no extra import needed.

### Error Handling

No error handling on the `explorer.exe` spawn. Browser launch is best-effort across all platforms (consistent with `mcp-oauth-provider.ts` and `browser.ts`). The URL is already visible so the user can always complete auth manually if the browser does not open.

---

## Testing

File: `src/providers/plugins/sso/__tests__/sso.auth.test.ts`

Three new test cases:

| # | Description | Key assertion |
|---|---|---|
| 1 | URL always printed | `console.log` called with `ssoUrl` before `open` or `spawn` |
| 2 | Windows path | `process.platform = 'win32'` → `spawn('explorer.exe', [url], ...)` called; `open` NOT called |
| 3 | macOS/Linux path | `process.platform = 'darwin'` → `open(url)` called; `spawn` NOT called |

**Patterns to reuse:**
- Platform override: `Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })` + `afterEach` restore — from `windows-path.test.ts`
- `child_process` spawn mock: `vi.mock('child_process', async (importOriginal) => ({ ...actual, spawn: vi.fn(() => mockChildProcess) }))` — from `BaseAgentAdapter.test.ts`
- `open` mock: `vi.mock('open', () => ({ default: vi.fn() }))` — from `browser.test.ts`

---

## Acceptance Criteria

- [ ] SSO URL is printed in the terminal before every browser launch attempt
- [ ] On Windows, `explorer.exe` is spawned (no `powershell.exe` involved)
- [ ] On macOS/Linux, `open()` is called as before
- [ ] With the `open` no-op simulation from the reproduction guide active, the user can paste the printed URL into a browser and complete `codemie setup` successfully
- [ ] Three new unit tests pass (URL print, Windows path, macOS/Linux path)
- [ ] Existing `sso.auth.test.ts` tests continue to pass
