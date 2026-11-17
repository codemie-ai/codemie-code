# EPMCDME-15957 Kimi Windows install fix — Implementation Plan

**Goal:** `codemie install kimi` / `kimi-acp` works on Windows by running Kimi's `install.ps1` through PowerShell (no cmd.exe), with step-aware errors and no leftover temp files, while Claude's Windows `install.cmd` command and macOS/Linux stay unchanged.

**Approach:** Choose installer type from the Windows URL extension (`.ps1` = PowerShell, otherwise existing batch path). No change to `installerUrls` type in `types.ts`. Commit per task using the repository's existing convention. Tests go in `src/utils/__tests__/native-installer.test.ts` (new; stub `process.platform`, `vi.mock` `processes.js`, `windows-path.js`, `logger`).

## Acceptance criteria

(Provided via requirements; spec-less flow.)
- Kimi/kimi-acp install on Windows from PowerShell and cmd with no exit-255 syntax error, including `--verbose`.
- Pinned version is passed via `KIMI_VERSION`; latest when none.
- Failures name the failed step or an actionable reason; no temp installer files remain; `KimiPlugin.uninstall` is not called on failure.
- Claude Windows command string byte-identical; macOS/Linux unchanged.

## Findings that shape the tasks

- `exec` (`src/utils/processes.ts:129`) passes `options.env` straight to spawn, so a provided env REPLACES `process.env`. Callers must merge `{...process.env, ...}` themselves.
- `ensureCommandInPath('kimi')` on a fresh install cannot find the dir via the stale process PATH, so Windows Kimi needs a `verifyPath`.
- Existing Windows exec-policy retry is moot for the PowerShell path (`-ExecutionPolicy Bypass`).

---

### Task 1 — PowerShell command builder and exported helpers
**Files:** `src/utils/native-installer.ts` (near `buildInstallerCommand`, l.69-130), new test file.
- Export `isPowerShellInstallerUrl(url)` (pathname ends `.ps1`) and `buildPowerShellInstallerArgs(url)` returning the args array `['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command', script]` (precedent: `codebase-memory.plugin.ts:42-55`). `-NonInteractive` makes install.ps1's `Read-Host` throw instead of hanging until the 300s timeout.
- Script: `$ErrorActionPreference='Stop'`; `try { $s = irm '<url>' } catch { Write-Output "[codemie-step:download] $_"; exit 1 }`; `try { iex $s } catch { Write-Output "[codemie-step:run] $_"; exit 1 }`; `exit 0`. Reuse the existing HTTPS check on the URL; reject any `'` in it.
- Export `buildInstallerCommand` unchanged in behavior (only add `export`) and fix the stale comments at l.18 and l.116.
- **Test-first: yes — `buildInstallerCommand` for windows with `https://claude.ai/install.cmd`, version `2.0.30`, flags `['--force']` returns exactly `curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd 2.0.30 --force && del install.cmd`; macOS/linux strings equal today's; `isPowerShellInstallerUrl` true for Kimi `install.ps1`, false for `install.cmd`/`install.sh`; PS args contain `-NoProfile`, `-NonInteractive`, `Bypass`, the URL, and no `cmd` syntax.**

### Task 2 — PowerShell execution path in `installNativeAgent`
**Files:** `src/utils/native-installer.ts` (`installNativeAgent` l.275-452, `NativeInstallOptions`).
- Add option `versionEnvVar?: string`. When platform is windows and URL is `.ps1`: call `exec('powershell', args, {timeout, env, shell:false})` where `env = {...process.env, ...options.env}` plus `[versionEnvVar]: version` only when version is set and not `latest`/`stable` (version already validated by semver check).
- Skip the exec-policy retry for this path. Non-PS paths keep the existing `exec(command, [], {shell:true})` calls untouched.
- Add `describeWindowsPowerShellFailure(output, code)` (exported): parse the `[codemie-step:...]` marker. `download` -> "Failed to download the Kimi installer from <url> (check network/proxy/TLS access to code.kimi.com)". `run` -> "Kimi installer script failed while running" plus a cleanup note: kimi.exe may already be copied to `%USERPROFILE%\.kimi-code\bin`, a `kimi.exe.bak` backup may exist, and the user PATH may have been modified; to remove, delete that folder and its PATH entry, or restore the `.bak`. No marker -> include exit code and sanitized output (`sanitizeValue`). Never call `KimiPlugin.uninstall`.
- Log the executable and step names at debug level (not the URL-bearing script body).
- **Test-first: yes — with `process.platform` stubbed to `win32` and `exec` mocked: Kimi `.ps1` URL calls `exec('powershell', [...], {shell:false})` (not `shell:true`, no `install.cmd`); env contains an inherited `PATH` and `KIMI_VERSION=0.42.0` when version `0.42.0`, no `KIMI_VERSION` for `latest`/undefined; a mocked exit 1 with `[codemie-step:download]` rejects with `AgentInstallationError` mentioning download; `[codemie-step:run]` message mentions `.kimi-code\bin` and `.bak`; exec-policy output triggers no retry.**

### Task 3 — Temp installer file cleanup on the batch path
**Files:** `src/utils/native-installer.ts`.
- The Claude command string cannot change, so when `del install.cmd` is skipped by a failed `&&` chain, remove it from Node: in a `finally` around the Windows batch exec, `fs.rm(path.join(process.cwd(), 'install.cmd'), {force:true})`, swallowing errors. Applies on success and every failure branch; not run on macOS/Linux or the PS path (nothing is written to disk).
- **Test-first: yes — with platform `win32`, Claude URL and `exec` mocked to exit 1 (and separately to throw), `fs.rm`/`unlink` is called for `install.cmd` with force; on `linux` and on the Kimi `.ps1` path it is not called.**

### Task 4 — Kimi plugin wiring
**Files:** `src/agents/plugins/kimi/kimi.plugin.ts` (`installNative` l.179-224), `src/agents/plugins/kimi/__tests__/kimi.plugin.test.ts`.
- Pass `versionEnvVar: 'KIMI_VERSION'` and, on win32, `verifyPath: join(homedir(), '.kimi-code', 'bin', 'kimi.exe')` (keep the existing Unix `verifyPath`). Confirm the default Windows install dir matches Kimi's `install.ps1` default (`KIMI_INSTALL_DIR` unset) — the ticket says `<dir>\bin\kimi.exe`; if it differs, adjust the path. `kimi-acp` inherits this; add no code there.
- Keep the failure path throwing `AgentInstallationError` with the step-aware message from Task 2 rather than the generic "Installation failed. Output:" text, and do not call `this.uninstall`.
- **Test-first: yes — extend the kimi plugin test: on win32, `installNativeAgent` receives options with `versionEnvVar: 'KIMI_VERSION'` and a `kimi.exe` `verifyPath`; on linux the options are unchanged; a rejected install does not invoke `uninstall`; `KimiAcpPlugin` passes the same options.**

---

## Self-check

- negative-constraints: (1) "Claude install.cmd string must stay byte-identical" — Task 1 test pins it, Tasks 2-3 leave that branch untouched. (2) "do NOT call KimiPlugin.uninstall after copy step" — Tasks 2 and 4 report only, Task 4 test asserts no call. (3) Out of scope (Kimi distribution, Unix installer/version pinning, Windows CI) — no task touches them; Unix verification and args are unchanged. (4) "no temp installer files" — PS path writes none (in-memory `irm | iex`), Task 3 covers batch path.
- Whole-suite gates, browser/manual verification and commits are left to the calling flow.
- Open risks: `install.ps1` behavior (marker-free output, `Read-Host` with `-NonInteractive`, default install dir) is unverified; Task 4 notes the path check.
