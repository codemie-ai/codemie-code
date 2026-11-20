# Spec: Gemini hooks must not open cmd.exe windows on Windows (EPMCDME-16975)

## Problem
Gemini CLI 0.70.0 runs every hook through `powershell.exe -Command <command>` and ignores a per-hook `shell` (analysis s.9). When the command is the extensionless codemie shim, PowerShell starts `cmd.exe /c codemie.cmd hook`, which opens a console window per hook event. Installs made before 0.16.3 still hold that command, because `resolveHookCommand` (src/utils/hook-command.ts:159-179) keeps an existing codemie path as valid and `resolveBinary` (:84-98) only appends `.cmd` for new resolutions.

## Approach
1. In the shared `resolveHookCommand`, on win32 only, rewrite an absolute extensionless codemie shim path to `<path>.cmd`, but only when that `.cmd` file exists. Applies to every host. No `hookHost` gate and no `"shell"` change.
2. Launch-time repair reuses the existing `localizeInstalledHooks` (BaseExtensionInstaller.ts:525-541, called at :701 and :705, copied and up-to-date branches). It is reached only through `defaultAgentHooks` (src/providers/core/default-agent-hooks.ts:20-50), wired into the sso and jwt templates alone. Gemini's own `beforeRun` (gemini.plugin.ts:154-180) never installs. LiteLLM has no agent hooks; the bedrock and ollama wildcard hooks only adjust env; moonshot-subscription's hooks were not read in full, and anthropic-subscription installs for Claude only (assumption: those launches do not repair).
3. Add migration `012` (next after 011, migrations/index.ts:35) that applies the same shared logic once at CLI startup to `~/.gemini/extensions/codemie/hooks/hooks.json`, covering every provider. Structure follows 006 (`006-...migration.ts:16-68`): skip on ENOENT, warn on other read errors, `success:false` with `reason: 'write-failed'` on write failure so it stays pending.

## Acceptance Criteria
- AC1: Given Windows and an installed Gemini `hooks.json` whose commands use the extensionless codemie shim whose `.cmd` exists, when the user next launches `codemie-gemini` with a provider that runs the extension install (sso/jwt), then every such command is rewritten to the `.cmd` shim and still invokes `codemie hook`. (story AC1)
- AC2: Given Windows and a fresh install, then every Gemini hook command uses the `.cmd` shim (regression guard). (story AC2)
- AC3: Given hooks already on the `.cmd` shim, when the repair runs again, then nothing changes and the file is not rewritten. (story AC3)
- AC4: Given the extensionless command and no `<shim>.cmd` beside it, when the repair runs, then the command is left as is and install does not fail. (story AC4)
- AC5: Given a non-Windows machine, when install, repair or the migration runs, then hook commands are unchanged. (story AC5)
- AC6: Given Claude hooks on Windows (quoted and unquoted paths), then the existing PowerShell pin and `& ` behavior is unchanged. (story AC6)
- AC7 (manual, run by the user after the flow): on Windows with extensionless hooks, a `codemie-gemini` headless turn opens no cmd.exe windows after the repair. (story AC7)
- AC8: Migration 012 on Windows rewrites extensionless Gemini hook commands to `.cmd` regardless of provider; is idempotent (a second run reports nothing to rewrite and does not write); returns `success: true` when the file is missing or unreadable; returns `success: false` with `reason: 'write-failed'` on a write error so it is retried; and is a no-op on non-Windows.
- AC9: Tests (Vitest, written first): `hook-command.test.ts` (extensionless to `.cmd`, idempotence, missing `.cmd`, non-win32, Claude pin unchanged); `BaseExtensionInstaller.hooks.test.ts` (win32 Gemini case); a new test file for migration 012 covering AC8. (story D1)

## Non-goals
- NG1: Changes to Gemini CLI or its hook executor. (story NG1)
- NG2: Adding `"shell": "powershell"` to Gemini hooks (no effect on Gemini). (story NG2)
- NG3: The OpenCode console flash (EPMCDME-16970, #494). (story NG3)
- NG4: Any change to the Claude pin beyond non-regression. (story NG4)
- NG5 (story): a new migration was out of scope unless the every-launch repair was not reached. It is not reached for litellm, bedrock, ollama and subscription providers, so the condition is met and NG5 is lifted by decision below. story.md is not edited.
- Changing `defaultAgentHooks` wiring or Gemini's `beforeRun` to install on every provider.
- Changing migrations 006/008 or the OTLP connector gates.

## Decisions
- Shared all-hosts win32 rewrite in `resolveHookCommand` over a Gemini-only or `hookHost`-gated change; answers the host scope question (story D2).
- Heal in `resolveHookCommand` over a Gemini-specific code path; the existing every-launch `localizeInstalledHooks` is reused (story D2).
- No `"shell"` field for Gemini over extending the pin to Gemini (refuted, analysis s.9).
- Add migration 012 over repair-on-launch only or calling the repair from `GeminiPlugin.beforeRun`; lifts story NG5 — user, answers Q1.
- Rewrite only when `<path>.cmd` exists over rewriting unconditionally, so a missing shim leaves a command that still works.
- Done means unit tests and passing quality gates, plus the manual Windows run (story D1).

## Open risks
- Real upgrade from a pre-0.16.3 install is not verified end to end (AC7 covers it manually).
- Gemini CLI versions other than 0.70.0 are not checked.
- Kimi's installer inherits `localizeInstalledHooks` but ships no hooks.json; it only logs a non-fatal warning (unverified).
- Migration 012 runs once: a Gemini extension installed after it ran, with an extensionless command, depends on the launch-time repair (sso/jwt only). Fresh installs write `.cmd` already.
- Migration hard-codes the Gemini path as 006 does (006:19); the path duplicates `gemini.extension-installer.ts:50-52`.
- The shared rewrite also changes Claude/OTLP hooks that hold an extensionless shim on win32 (intended healing; AC6 guards the pin).
