# Verification Guide — EPMCDME-13664 SSO Windows Browser Fallback

## 1. Run the unit tests

```bash
npx vitest run src/providers/plugins/sso/__tests__/sso.auth.test.ts
```

Expected: 6 tests pass (3 existing `deriveExpiresAt` + 3 new browser-launch tests).

## 2. Build

```bash
npm run build
```

Confirms no TypeScript errors were introduced.

## 3. Verify the URL always prints (any platform)

Run the SSO flow on any machine:

```bash
node dist/bin/codemie.js setup
# select: CodeMie SSO
```

Verify the terminal shows:
```
Opening browser for authentication...

If the browser doesn't open, navigate to this URL manually:
https://<your-codemie-host>/code-assistant-api/v1/auth/login/<port>
```

The URL line must appear **before** the browser opens, not after.

## 4. Verify Windows path uses `explorer.exe` (not PowerShell)

On a Windows machine, while the SSO prompt is waiting:

1. Open **Task Manager → Details** tab.
2. Look for `explorer.exe` with your user as owner and a recent start time (a new instance, not the shell).
3. Confirm there is **no** `powershell.exe` process that appeared at the same moment.

Alternatively, run [Process Monitor](https://learn.microsoft.com/en-us/sysinternals/downloads/procmon) filtered to `Process Name is powershell.exe` — it should show no spawn from the `codemie` process during the SSO step.

## 5. Verify on a WDAC/AppLocker-restricted machine (the original bug)

On a corporate machine where the bug was reported:

1. Run `codemie setup` → SSO.
2. The URL prints to terminal.
3. The browser **opens** (explorer.exe is whitelisted).
4. Complete the auth flow in the browser.
5. Confirm `codemie setup` exits successfully.

If you can't get a WDAC machine, the URL-always-prints check (Step 3) is the best proxy — it ensures users can complete auth manually even if the browser launch is blocked.

## 6. Verify macOS/Linux is unchanged

On macOS or Linux, repeat Step 3. Confirm the URL prints and the default browser opens normally. No regression expected since that path still calls `open()`.

## 7. Verify pre-commit hooks still pass (regression check for the statusline fix)

```bash
git stash  # if you have uncommitted changes
git commit --allow-empty -m "test: verify hooks"
```

The pre-commit hook runs `vitest related` on touched files. Confirm it completes without the timeouts that were present before (the statusline test suite should pass in under 30 seconds).
