# Spec: EPMCDME-16982 - `codemie install pi` fails on Windows

## Problem

1. On Windows `pi` is a `pi.cmd` shim. `installRequiredPiPackages` calls `exec(cliCommand, ['install', pkg], {cwd, timeout})` with no `shell` (`src/agents/plugins/pi/pi.packages.ts:35`). `exec()` defaults to `shell: false` (`src/utils/exec.ts:47-50`), so the spawn fails with `spawn pi ENOENT`. The `where`-based installed check passes, which is why the failure appears after "Pi is installed".
2. When Pi is already installed, `install.ts` still calls `additionalInstallation` (`install.ts:137-141`, `161-170`), and `PiPlugin.additionalInstallation` (`pi.plugin.ts:498-502`) re-runs the package install every time.

## Behavior

- B1: The `pi install <pkg>` spawn uses `shell: process.platform === 'win32'`, as the npm/npx spawns do (`processes.ts` `shell: isWindows`). The change is in `pi.packages.ts` only; `exec()` is not changed.
- B2: `install.ts` adds `alreadyInstalled: true` to the options it passes to `additionalInstallation` in the two already-installed branches. The fresh-install call (`install.ts:221-223`) is unchanged. `AgentInstallationOptions` already has an index signature (`types.ts:718-723`), so this is additive and Claude ignores it.
- B3: `PiPlugin.additionalInstallation` returns early, with a `logger.info`, when `options?.alreadyInstalled === true`. A fresh Pi install still installs the required packages.

## Acceptance criteria

- AC1: `pi.packages.ts` passes `shell` set to true only on win32 in the `exec` options.
- AC2: `exec.ts` and its callers are unchanged. The diff touches only `pi.packages.ts`, `pi.plugin.ts` and the two already-installed call sites in `install.ts`.
- AC3: `additionalInstallation` for Pi does not call `installRequiredPiPackages` when `alreadyInstalled` is true, and does call it otherwise.
- AC4: Claude's `additionalInstallation` (sounds) still runs in the already-installed branches with the same options plus the extra key.
- AC5: `npm run typecheck`, `npm run lint` and `npm run build` pass.
- AC6: Verification does not run the real installer, `npm link`, a global install, or `pi install`. It does not touch `~/.codemie`, `~/.pi` or the global npm prefix.

## Non-goals

- No change to `exec()` defaults or its doc comment.
- No fix for the same `.cmd` flaw in `BaseAgentAdapter.getVersion` or other plugins' version probes.
- No quoting or resolution of a `CODEMIE_PI_BIN` path containing spaces.
- No new tests (repo policy: tests only on request).
- No change to the "Unknown provider codemie-anthropic" issue (PR #485).
- No self-healing of missing Pi packages when Pi is already installed.

## Decisions

- Windows shell fix local to `pi.packages.ts` over changing `exec()` defaults (about 30 callers, some rely on shell:false array args).
- Skip signal is an additive `alreadyInstalled` option set in `install.ts` over a Pi-local check, because `additionalInstallation` runs after a fresh install too and `isInstalled()` cannot tell the cases apart. A `pi list` probe was rejected: its output format is unverified and it adds a spawn.
- Skip applies to both already-installed branches (version match and no version requested) over only one.

## Risks

- A user with Pi installed but missing the required packages will not get them from `codemie install pi`. This is the requested behavior. Re-running after uninstalling Pi, or running `pi install` by hand, is the way to get them.
- Under `shell: true`, `CODEMIE_PI_BIN` paths with spaces are unquoted (see non-goals). The default `pi` is unaffected.
- The Windows behavior is verified only by review, not by running it, because of AC6.
