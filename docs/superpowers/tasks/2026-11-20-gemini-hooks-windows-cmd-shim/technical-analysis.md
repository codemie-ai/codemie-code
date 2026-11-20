# Technical Research

> Updated 2026-11-20 with reproduction findings (Jira comments of 20/Nov/26); supersedes the root cause in section 1. Repo state now: upstream/main 40b53063, package 0.17.0.

**Task**: codemie-code gemini agent extension hooks windows powershell shell cmd.exe hookHost BaseExtensionInstaller migration
**Generated**: 2026-11-18
**Research path**: filesystem

Scope: repository `codemie-code` (git HEAD 608d79a1, package 0.16.10), workspace root `C:/code/codemie-dev`. Codegraph unavailable; Glob/Grep/Read only. No code changed. Citations are `codemie-code:<path>:<line>`.

---

## 1. Original Context

Jira EPMCDME-16975 (Bug). Summary: "codemie-gemini: hooks.json isn't pinned to a quiet shell on Windows, so every hook event flashes an empty cmd.exe window".

On Windows, running `codemie-gemini` causes empty black `cmd.exe` console windows to repeatedly pop up and steal focus (CMD, PowerShell, and the VS Code integrated terminal). This is distinct from EPMCDME-16970 (#494, OpenCode's `execCommandAsync` missing `windowsHide`), which is a different agent and a different root cause.

Root Cause (confirmed on main @ HEAD):
- `BaseExtensionInstaller.ts:520-536` only pins hooks to run via PowerShell on Windows when `hookHost === 'claude'`. The code comment reads: "Hook runner differs per host; only Claude hooks are pinned to PowerShell on Windows."
- The same gate is repeated in the hook-repair migrations (`006-resolve-hook-command-paths.migration.ts:43` and `008-repair-hook-shell-and-stale-paths.migration.ts`).
- `GeminiExtensionInstaller` never overrides `hookHost`, so it stays `'other'`.
- Gemini's `hooks.json` (`src/agents/plugins/gemini/extension/hooks/hooks.json:1-77`) defines six events, including `BeforeAgent` and `AfterAgent`, which fire on every prompt and response. Each runs a bare `"command": "codemie hook"` with no `"shell"` field. Gemini CLI's native hook executor therefore falls back to its default Windows shell, which produces the cmd.exe flash on every turn.

Steps to Reproduce: 1. On Windows, install and run `codemie-gemini` (CMD, PowerShell, or VS Code integrated terminal). 2. Observe empty console windows popping up repeatedly during normal use (once per hook event/turn).

Suggested Fix: Extend the PowerShell-pinning fix already applied for Claude (`hookHost === 'claude'`) to Gemini and other non-Claude hosts, in `BaseExtensionInstaller.ts` and the corresponding repair migration.

Reference: GitHub issue https://github.com/codemie-ai/codemie-code/issues/533
Acceptance criteria: none in the ticket.

feature_area: codemie-code gemini agent extension hooks windows powershell shell cmd.exe hookHost BaseExtensionInstaller migration

---

## 2. Codebase Findings

### Existing Implementations

Purpose P1: on Windows, codemie's Gemini hooks run without a console window flashing per hook event.

- **Install-time shell pin (base class).** `codemie-code:src/agents/core/extension/BaseExtensionInstaller.ts:523` declares `hookHost: 'claude' | 'other' = 'other'`. `:532` computes `powershell = this.hookHost === 'claude' && process.platform === 'win32'`; `:533` calls `rewriteHooksCommandTree(parsed.hooks, binary, powershell)`; `:537-539` logs and swallows errors (non-fatal). Called from install at `:701` (after copy and verify) and `:705` (already-up-to-date branch). It rewrites the installed copy, not the source. Distance from the purpose: indirect; the pin only exists if this gate is true and the binary path is quoted (see next items).
- **Subclass override.** `codemie-code:src/agents/plugins/claude/claude.plugin-installer.ts:33` sets `hookHost = 'claude' as const`. `codemie-code:src/agents/plugins/gemini/gemini.extension-installer.ts:27-34` does not override, so it inherits `'other'`. Kimi (`codemie-code:src/agents/plugins/kimi/kimi.extension-installer.ts:26`) also inherits.
- **Rewrite helper.** `codemie-code:src/utils/hook-command.ts:136-167` `rewriteHooksCommandTree`: `:155-158` sets `record.shell = 'powershell'` only when the rewritten command starts with `& `. That prefix is added by `resolveHookCommand` (`:114-115`, `render`) only when `powershell` is true and the binary string starts with `"`. Rule: the pin fires only for a quoted binary.
- **Binary quoting.** `codemie-code:src/utils/hook-command.ts:11` `NEEDS_QUOTING` (space, tab, and `,;=()&|<>^%[]{}`); `:40-42` `quoteIfNeeded`; `:64-88` `resolveBinary`, whose `:71` returns the quoted or bare path (`:81-83` always quotes the node+script form on Windows).
- **Migration 006 gate.** `codemie-code:src/migrations/006-resolve-hook-command-paths.migration.ts:16-21` `hookFiles()` pairs the Claude file (`claude: true`) with the Gemini file (`claude: false`); `:43` `const powershell = claude && process.platform === 'win32'`; `:44` rewrite; `:67` registration. The Gemini path at `:19` duplicates `gemini.extension-installer.ts:50-52`.
- **Migration 008.** `codemie-code:src/migrations/008-repair-hook-shell-and-stale-paths.migration.ts:6-9` extends the 006 class and overrides only `id` and `description`. It inherits `hookFiles` and `up`, so the gate is identical. Registered at `codemie-code:src/migrations/index.ts:32` (006 at `:30`).
- **Platform-only pin (OTLP connector).** `codemie-code:src/cli/commands/proxy/connectors/claude-code-otlp.ts:335-341` `localizeCodemieHookCommands` calls `rewriteHooksCommandTree(entries, binary, process.platform === 'win32')`. No host check.

Subject file and installer:
- `codemie-code:src/agents/plugins/gemini/extension/hooks/hooks.json`: six events, keys at `:4` SessionStart, `:16` SessionEnd, `:28` AfterAgent, `:40` BeforeAgent, `:52` PreCompress, `:64` Notification. Each `command` is `"codemie hook"` (lines `:9, :21, :33, :45, :57, :69`). No `shell` key anywhere in the file. BeforeAgent timeout 180000 at `:47`.
- `codemie-code:src/agents/plugins/gemini/gemini.extension-installer.ts:40-44` source is `extension/`; `:50-52` target `~/.gemini/extensions/codemie`; `:66-68` critical files include `hooks/hooks.json`.
- Event mapping consumer: `codemie-code:src/agents/plugins/gemini/gemini.plugin.ts:97-123` (AfterAgent to Stop at `:119`, BeforeAgent to UserPromptSubmit at `:120`).

Claude comparison: `codemie-code:src/agents/plugins/claude/plugin/hooks/hooks.json` uses bare `codemie hook` and `codemie sound X` commands with no `shell` key. The pin exists only in the installed copy.

Other touched code: `codemie-code:src/agents/core/extension/BaseExtensionInstaller.ts:488-518` `shouldUpdateLocal` (copy versus up-to-date); `:553-575` `getInstalledInfo` (requires hooks.json readable). Not on this path: codemie's own spawns set `windowsHide` at `codemie-code:src/utils/exec.ts:77` and `codemie-code:src/agents/core/BaseAgentAdapter.ts:937`. The hook executor named in the ticket is Gemini CLI, which is not in this repo.

### Decisions Already in the Code

- **D1 Host-gated pinning.** `BaseExtensionInstaller.ts:522` comment: "Hook runner differs per host; only Claude hooks are pinned to PowerShell on Windows." Alternative: pin for every host on win32. Recorded reason: the comment only; no ADR found. The host is a per-subclass field (`claude.plugin-installer.ts:33`).
- **D2 Pin mechanism is Claude-specific.** `hook-command.ts:111-112` and `:134-135`: `"shell": "powershell"` plus `& ` prefix, so "Claude Code no longer picks bash/PowerShell by guessing". No Gemini-side reasoning in the repo.
- **D3 Repairs are idempotent and non-fatal.** `BaseExtensionInstaller.ts:520-521` and `:537-539`; migrations retry on write failure (`006:50-52`).
- **D4 Three gates, three rules.** Base class per instance (`:532`), migration per path flag (`006:43`), connector per platform (`claude-code-otlp.ts:341`). No recorded reason.
- **Release note.** `codemie-code:CHANGELOG.md:178` (in `[0.16.3] - 2026-10-30`): "Codemie hooks run under PowerShell on Windows, and stale hook paths are healed automatically".
- Data direction: not applicable.

### Task Statements Checked Against the Code

- "Pins only when `hookHost === 'claude'`" (`:520-536`): **holds**, `BaseExtensionInstaller.ts:532`. The pin also requires a quoted binary (`hook-command.ts:115`, `:155`).
- "Same gate repeated in 006:43 and 008": **holds** for `006:43`. 008 holds only by inheritance (`008:6-9`); there is no literal gate in that file.
- "GeminiExtensionInstaller never overrides hookHost": **holds**, `gemini.extension-installer.ts:27-34`. `hookHost` appears in `src` only at `BaseExtensionInstaller.ts:523, :532` and `claude.plugin-installer.ts:33`.
- "Six events incl. BeforeAgent and AfterAgent, each a bare `codemie hook` with no shell field": **holds**, `hooks.json:4, :16, :28, :40, :52, :64` and command lines `:9-:69`; zero `"shell"` matches in the file.
- "Gemini CLI's native executor falls back to the default Windows shell, causing the cmd.exe flash": **refuted**, evidence in section 9. Gemini CLI never reads a per-hook `shell` and always runs `powershell.exe`; the flash comes from the extensionless codemie shim in the hook command.
- "Fix: extend hookHost to Gemini and other non-Claude hosts": **would not remove the flash** (section 9). Gemini ignores `shell`, so the gate change cannot affect the windows. No installer-level test covers a Gemini host on win32 (Section 4).
- "Distinct from EPMCDME-16970 (OpenCode execCommandAsync windowsHide)": **unverified** in this repo; OpenCode code is outside this scope.
- "Reference: GitHub issue 533": **unverified**; not read.

### Consumers of Changed Contracts

Changed by the fix: the `hookHost` gate (`BaseExtensionInstaller.ts:532`), the installed Gemini `hooks.json`, and the `powershell` semantics of `rewriteHooksCommandTree`.

- `BaseExtensionInstaller.ts:533` (base caller), `:701` and `:705` (install paths).
- `006-resolve-hook-command-paths.migration.ts:44`; 008 inherits (`008:6-9`).
- `claude-code-otlp.ts:341` (separate caller, platform-gated; not governed by `hookHost`).
- `hook-command.ts:119` (`resolveHookCommand` head parse); `codemie-code.plugin.ts:17` imports `resolveCodemieBinary, resolveHookCommand`; `:308` uses `resolveCodemieBinary`.
- Readers of installed `hooks.json`: `BaseExtensionInstaller.ts:565-566` (existence check). The Gemini CLI reads the file; its reader is outside the repo.
- Kimi: `kimi.extension-installer.ts:26` inherits. No `hooks/hooks.json` exists under `src/agents/plugins/kimi` (Glob). If Kimi install reaches `localizeInstalledHooks`, the read fails and logs a warning (`BaseExtensionInstaller.ts:529, :539`). Not verified.

### Architecture and Layers Affected

- Agent extension install layer: `src/agents/core/extension/BaseExtensionInstaller.ts`, with subclasses `claude.plugin-installer.ts` and `gemini.extension-installer.ts`.
- Utility layer: `src/utils/hook-command.ts` (`resolveHookCommand`, `rewriteHooksCommandTree`, `resolveBinary`).
- Migration layer: `src/migrations/006-...` and `008-...` (inheritance).
- Agent asset: `src/agents/plugins/gemini/extension/hooks/hooks.json`.
- Connector (not governed by hookHost): `src/cli/commands/proxy/connectors/claude-code-otlp.ts`.

### Integration Points

- Internal: installer dynamically imports hook-command (`BaseExtensionInstaller.ts:527`); migrations import it statically (`006:6`). Migration 006 hard-codes the Gemini path (`:19`) that the installer also defines.
- External: Gemini CLI reads `~/.gemini/extensions/codemie/hooks/hooks.json` (inferred from the install target; reader not in repo). The `codemie` binary is resolved via `getCommandPath` (`hook-command.ts:66`).

### Patterns and Conventions

- Template method: protected hooks in `BaseExtensionInstaller` overridden by subclasses (`protected override readonly` at `claude.plugin-installer.ts:33`; `getSourcePath`/`getTargetPath` at `gemini.extension-installer.ts:40-52`).
- Migration inheritance: 008 extends 006 and both self-register (`006:67`, `008:11`).
- Install-side repair: try/catch with `logger.warn`, non-fatal (`BaseExtensionInstaller.ts:537-539`).
- Tests: Vitest with `vi.doMock` and `vi.resetModules` (Section 4).

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/` exists (architecture, development, integration, standards, testing, usage, security, project.md, quality-gates.md). None covers hook shell pinning or Gemini hooks. `integration/external-integrations.md:10` lists Gemini only as a model provider.
- `openwiki/workflows/hooks-skills-frameworks-and-automation.md:114` notes hook commands run in the invoking user's shell environment. No Windows shell detail.

### Architectural Decisions

- No ADR for `hookHost`. The only recorded reason is the comment at `BaseExtensionInstaller.ts:522`.
- EPMCDME-14035 and EPMCDME-15907 are cited in code comments (`BaseExtensionInstaller.ts:521`, `hook-command.ts:4` and `:124`, `008:5`). No linked design document was found in the repo.

### Derived Conventions

- Per-host divergence is a subclass field (`BaseExtensionInstaller.ts:522-523`). The ticket's fix extends this convention.
- Install-side repair is idempotent and non-fatal (`:520-521`, `:537-539`).

---

## 4. Testing Landscape

### Existing Coverage

- `codemie-code:src/utils/__tests__/hook-command.test.ts:35-42` `&` prefix add/remove with the powershell flag; `:44-51` node+script form; `:53-57` stale .exe/.ps1 heal; `:59-69` pins `"shell": "powershell"` only when the flag is true, with a quoted binary; `:145-169` rewrite without pin; `:71-140` binary resolution including Windows slash and quote cases.
- `codemie-code:src/agents/core/extension/__tests__/BaseExtensionInstaller.hooks.test.ts:6-74`: a TestInstaller subclass (hookHost default `'other'`); mocks `processes.js` so `getCommandPath` returns `/abs/codemie` (`:18-20`); asserts `/abs/codemie hook` (`:71-73`). No platform mock, no shell assertion, no Claude or Gemini subclass.
- `codemie-code:src/migrations/__tests__/006-resolve-hook-command-paths.migration.test.ts:63-102`: Claude rewrite, no-op, idempotence, EACCES returns `success: false`. Seeds Claude hooks only (`:47-61`).
- `codemie-code:src/agents/core/extension/__tests__/BaseExtensionInstaller-windows.test.ts:1-228`: path-separator and glob tests for sound assets. No hook or shell assertions despite the name.
- `codemie-code:src/agents/plugins/gemini/__tests__/gemini.extension-installer.test.ts:198, :204, :270, :286` mention hooks.json only as mock fixtures. No win32 or shell case.
- `codemie-code/src/agents/plugins/claude/__tests__/plugin-installer.test.ts`: no matches for hookHost, win32, shell or powershell.
- `codemie-code/src/cli/commands/proxy/connectors/__tests__/claude-code-otlp.test.ts`: no matches for shell, win32 or powershell.

### Testing Framework and Patterns

- Vitest (`AGENTS.md`). Patterns: `vi.doMock` for `processes.js` and `os` (006 test `:26-29`), `vi.resetModules` in `beforeEach`, `mkdtemp` temp homes, `CODEMIE_HOME` override (006 test `:19-25`; set globally by `vitest.config.ts` per the comment).
- Platform is not mocked where the pin is tested; hook-command tests pass the powershell flag explicitly.

### Coverage Gaps

- No test asserts the `hookHost` gate for `ClaudePluginInstaller` or `GeminiExtensionInstaller` on win32.
- No Gemini-path case in 006. No 008 test file (Glob `**/*008*.test.ts` under `src/migrations` is empty).
- No test for `claude-code-otlp.ts` `localizeCodemieHookCommands`.

---

## 5. Configuration and Environment

### Environment Variables

- `CODEMIE_HOME`: root for `getCodemiePath`; used by 006 (`006:18`) and its test. No env var selects the hook shell in the searched files.

### Configuration Files

- Installed targets: `~/.gemini/extensions/codemie/hooks/hooks.json` (`gemini.extension-installer.ts:50-52`); `~/.codemie/claude-plugin/hooks/hooks.json` (`claude.plugin-installer.ts:57-59`); version file `~/.codemie/gemini.extension.json` (`BaseExtensionInstaller.ts:492`).
- Manifest: `codemie-code:src/agents/plugins/gemini/extension/gemini-extension.json` (critical file, `gemini.extension-installer.ts:67`). Not read in detail.

### Feature Flags and Deployment Concerns

- No feature flags found in the searched files.
- Deployment: the extension is copied at install (`BaseExtensionInstaller.ts:678-682`), localized at `:701` or `:705`. Migrations 006 and 008 rewrite the installed file on upgrade (`migrations/index.ts:30, :32`); the migration runner was not read.
- Secrets: none in this path.

---

## 6. Risk Indicators

- **Resolved by section 9:** Gemini CLI does not honour a per-hook `"shell"` field (0.70.0 never reads it).
- **Resolved by section 9:** quoting. The pin needs a quoted binary, so it does not fire for a typical space-free Windows path; this is unrelated to the fix.
- **Unresolved, other hosts:** only Claude, Gemini and Kimi subclass the base installer; Kimi ships no `hooks.json` in `src`. Other hosts were not checked.
- **Three divergent gates:** `BaseExtensionInstaller.ts:532`, `006:43`, `claude-code-otlp.ts:341`. A base-only change leaves 006 and 008 gated on `claude`.
- **Open, upgrade path (still open):** if migration 008 is already recorded as applied, it may not rerun; a fix may need a new migration id. Migration registry not read.
- **Test gap:** no win32 installer-level test of the gate; no 008 test; no Gemini case in 006.
- **Flash source:** attributed to Gemini CLI's executor; codemie's own spawns already set `windowsHide` (`exec.ts:77`, `BaseAgentAdapter.ts:937`). Unverified.

---

## 7. Summary for Complexity Assessment

Summary of section 9 (supersedes the earlier premise):
- The flash is caused by the extensionless codemie shim in the Gemini hook command; Gemini 0.70.0 ignores `shell` and always runs PowerShell, which starts `cmd.exe /c` for the shim. A `.cmd` path opens no windows.
- Fresh installs on 0.16.3+ already write `.cmd` (`resolveBinary`); installs from before 0.16.3 keep the extensionless command because `resolveHookCommand` treats an existing codemie path as valid.
- The fix is a repair in the shared hook-command logic, healed by `localizeInstalledHooks` on every install call; extending `hookHost` to Gemini is not a fix.
- Test gaps: no win32 Gemini installer test, no Gemini case in the 006 test, no 008 test.

---

## 8. External References

- Named but not read (outside repo): GitHub issue `https://github.com/codemie-ai/codemie-code/issues/533`, and EPMCDME-16970 / #494.
- Ticket-cited repo paths resolved: `BaseExtensionInstaller.ts:520-536`, `006...:43`, `008...` (by inheritance), `hooks.json:1-77`.

---

## 9. Verified reproduction findings

Verified 2026-11-20.

Reproduction (Windows 11, Node 24, Gemini CLI 0.70.0; `codemie-gemini --model gemini-3.5-flash -p "reply with the single word ok"`, GEMINI_CLI_TRUST_WORKSPACE=true, hidden parent console, windows counted by a script and confirmed visually):
  v0.15.9 fresh install, hook command `C:/.../npm/codemie hook` (extensionless): 5 hooks, 5 visible cmd.exe windows
  upstream/main fresh install, hook command `C:/.../npm/codemie.cmd hook`: 5 hooks, 0 windows
  upstream/main with hooks.json edited back to the extensionless command: 5 hooks, 5 windows
Each window is `cmd.exe /c ""...\codemie.cmd" hook"` started by Gemini's hook PowerShell; it gets its own console.

Root cause (corrected):
- Gemini CLI 0.70.0 (`executeCommandHook`, bundle chunk-37D3S3FZ.js) reads only name, type, command, timeout, env from a hook. It never reads `shell`. On Windows it always runs `powershell.exe -NoProfile -NonInteractive -Command <command>`, with no windowsHide. So pinning `"shell": "powershell"` for Gemini cannot remove the windows. Do not plan it.
- The trigger is the extensionless codemie shim in the hook command. A `.cmd` path opens no windows.
- Commit 8b8bedb6 (#656, release 0.16.3) made `resolveBinary` (src/utils/hook-command.ts) append `.cmd` on win32 when `<shim>.cmd` exists. That applies to every host, so fresh installs are fine. It is also the commit that shipped the Claude PowerShell pin.
- Gap: `resolveHookCommand` keeps an existing codemie path as valid, since `isCodemiePath` is true for extensionless `codemie` and the file exists. The extensionless command is therefore never rewritten, and installs made before 0.16.3 keep flashing. Verified: launching `codemie-gemini` on main left hand-edited extensionless hooks unchanged.
- `BaseExtensionInstaller.localizeInstalledHooks` runs on every install call, including the "already up-to-date" branch (BaseExtensionInstaller.ts around lines 701 and 705). Whether `codemie-gemini` launch reaches it every time must be confirmed from the code. If it does, no new migration is needed. Migrations 006/008 are tracked by id and run once.
- The PowerShell pin (`& ` prefix + `"shell"`) needs a quoted binary (hook-command.ts); a typical Windows path has no spaces, so the pin does not fire. This is unrelated to the fix.

Existing tests to extend: `src/utils/__tests__/hook-command.test.ts`, `src/agents/core/extension/__tests__/BaseExtensionInstaller.hooks.test.ts` (no win32 case today). Gaps: no win32 installer test for Gemini, no Gemini case in the 006 test, no 008 test.

Not verified (carry as open risks): real upgrade from a pre-0.16.3 install end to end; Gemini CLI versions other than 0.70.0; whether the Kimi installer reaches `localizeInstalledHooks` with no hooks.json.
