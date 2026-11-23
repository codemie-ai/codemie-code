# Technical Research

**Task**: claude bedrock settings conflict
**Generated**: 2026-11-17
**Research path**: filesystem

---

## 1. Original Context

Review the reported issue (Claude Bedrock settings override the CodeMie gateway) and implement the fix. Brief is available at <workspace>/claude-bedrock-conflict/brief.md (read it in full — it holds the requirements, acceptance criteria and integration points; a repro kit sits next to it in <workspace>/claude-bedrock-conflict/repro).
Repository root: <workspace>/codemie-code (branch fix/claude-bedrock-settings-conflict). Do not put ticket IDs/links in any repo file you write.

(Brief content is summarised in Section 8; it states 11 ACs, 8 source classes, user decisions "back up and switch, or cancel", Bedrock only, no docs, tests required.)

---

## 2. Codebase Findings

### Existing Implementations

Purpose A: detect that Claude's own settings select Bedrock.
- `src/agents/plugins/claude-code-otlp/event-fields/claude-settings-env.ts` — `settingsLayerPaths()` (:21, user via `CLAUDE_CONFIG_DIR` else `resolveHomeDir('.claude')`, project `settings.json`, project `settings.local.json`, then managed), `managedSettingsPaths()` (:14, single `managed-settings.json` per platform; win32 lists Program Files and ProgramData), `readClaudeSettingsEnv()` (:60). Merges only the `env` blocks, returns `{env, complete, apiKeyHelper?}`; does not say which layer set a key. Layer read: ENOENT/ENOTDIR = absent; any other read error AND any JSON.parse failure = `unreadable` -> `complete:false` (brief 3.1 J says malformed = not in effect). No `managed-settings.d/`, plist or registry. Consumers: `claude-code-otlp.plugin.ts:75,121` (only production caller); tests mock it in `claude-evidence-inputs.test.ts:10`, `routing-contract.test.ts:35`; own tests `claude-code-otlp/__tests__/claude-settings-env.test.ts` (asserts `managedSettingsPaths('linux'|'darwin'|'win32')` exact values and layer order).
- `src/agents/core/evidence/routing.ts:101` `flagState` (off: `''/0/false/no/off`; on: `1/true/yes/on`; else unknown), `:120` `effectiveEndpointEnv` (settings env over process env), `:208` `resolveEndpoint`, `:248` `routedViaCodemie`. `flagState` and `effectiveEndpointEnv` are module-private (not exported). Used by `oauthAccountPays` (:161), `fundingRoute` (:180). Bedrock keys already enumerated there: `ENDPOINT_KEYS` (:106), `CLOUD_FLAGS`, `CREDENTIAL_KEYS` (incl. `AWS_BEARER_TOKEN_BEDROCK`).
- `src/agents/plugins/claude/settings-conflict.ts` — `detectSettingsConflict(env)`: reads only `<resolveHomeDir('.claude')>/settings.json`, checks `env.ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL` vs profile. No Bedrock awareness. Called at `claude.plugin.ts:405` inside `beforeRun`, prints a warning only. Tests: `claude/__tests__/settings-conflict.test.ts` (mocks `fs`, `fs/promises`, `utils/paths.js`), `claude.plugin.conflict.test.ts` (mocks the module, ~20 cases).
- Claude Desktop: `src/cli/commands/proxy/connectors/desktop.ts` `getDesktopConfigPath` (~:690; reads `_meta.json` appliedId, safe-id check, else fresh UUID path), `describeManagedSettingsOverride` (~:672), `buildGatewayConfig` (:651), `writeDesktopConfig` (:722). `writeDesktopConfig` reads existing config (parse failure -> `{}`), merges, deletes `inferenceModels` (:849 and :998), writes without prompt or backup; no reference to `inferenceBedrock*` anywhere in `src` (grep). `src/telemetry/clients/claude-desktop/claude-desktop.paths.ts` `getClaudeDesktopBaseDir`, `getClaudeDesktopManagedSettingsPath` (returns a path only on linux; null on macOS/Windows by design, per its comment).
- VS Code: `connectors/vscode-claude-code.ts` `getVsCodeClaudeCodeSettingsPath(insiders)` (:38), JSONC `modify`/`applyEdits` with `jsonc-parser` (dep present, package.json:141), `claudeCode.environmentVariables` handled as an array of entries (:116-190), `writeAtomically` imported from `connectors/vscode.js` (:15, used :212, :317).
- Shell-env pass-through: `BaseAgentAdapter.ts:603` builds `{...process.env, ...envOverrides, ...}`; no key removal for `CLAUDE_CODE_USE_BEDROCK` anywhere (grep: only provider templates, routing, OTLP env fields, workflows templates).
- Bedrock provider profile: `src/providers/plugins/bedrock/bedrock.template.ts:94-110` sets `CLAUDE_CODE_USE_BEDROCK`, clears `ANTHROPIC_AUTH_TOKEN` and base URL for Claude (per-process env).

Purpose B: ask the user / run non-interactively.
- `src/utils/interactive.ts` `isNonInteractiveEnvironment` (:14, stdin not TTY), `canPromptForProject` (:23, also `--task`, `CODEMIE_NO_PROMPTS=1`, stdout TTY).
- `src/providers/core/launch-project-prompt.ts:65-93` inquirer prompt with injectable `prompt`/`exit` deps, SIGINT listener -> exit 130, keep-alive interval. `src/cli/commands/proxy/prompts/analytics-confirmation.ts` (+ `__tests__`).
- `AgentCLI.ts:208-210` `isNonInteractiveMode = !!options.task || isNonInteractiveEnvironment() || !process.stdout.isTTY`. ACP: `claude-acp.plugin.ts` `silentMode: true` metadata; `ClaudeAcpPlugin extends ClaudePlugin`.

Purpose C: backup then edit.
- `connectors/claude-code-otlp.ts:244` `SETTINGS_BACKUP_SUFFIX='.codemie-backup'` (beside the file; `proxy disconnect` restores/deletes it), copy snapshot (~:560-580), `writeAtomically`. Search for `~/.codemie/backups` / `getCodemiePath('backups')`: none found. `getCodemiePath(...)` at `src/utils/paths.ts:385`.

Other touched code (not above):
- `src/agents/core/AgentCLI.ts` `handleRun` (:182): auth validation (:326), launch identity/project prompt (:348-358), analytics auth (:~365-390), `validateCompatibility` (:394). `process.exit(1)` is the failure convention here.
- `src/cli/commands/install.ts`: agent resolved at ~:104-106 (`AgentRegistry.getAgent`); no profile loaded in this command.
- `src/cli/commands/proxy/connect-orchestrator.ts`: non-interactive guard (:~887), `resolveSsoProxyConfig` (:~894), `verifySsoCredentials`, OTLP confirm/decline (:~937-948), `syncRegisteredSkills`/`syncPluginSkills` (:~953). `proxy/index.ts:345-370` target options; `--silent` option text says it skips the OTLP confirmation.
- `src/agents/core/lifecycle-helpers.ts:84-95` `resolveHook` chains wildcard+specific hooks when both exist; with only a wildcard hook the specific one is not used (consistent with brief 10 separate bug).
- Errors: `ConfigurationError` in `src/utils/errors.ts`.

### Decisions Already in the Code

- Convention: pre-launch gates live in `AgentCLI.handleRun` as inline `process.exit(1)` with chalk messages; connect gates throw `ConfigurationError` (`connect-orchestrator.ts` ~:887).
- Convention: dynamic imports (`await import('./x.js')`) inside handlers; `.js` extensions, `@/` alias allowed (used in `claude-settings-env.ts:3`).
- Decision: settings `env` beats process env (`routing.ts:111-130` doc comment); managed > project local > project > user (`claude-settings-env.ts:20` comment "later wins").
- Decision: unknown flag spellings are never treated as off (`routing.ts:95-100`).
- Decision: `writeDesktopConfig` drops unparseable existing config silently (`existing = {}`), i.e. a corrupt applied config is overwritten without backup; alternative (stop) not taken, reason none found.
- Decision: `.codemie-backup` sibling suffix owned by `claude-code-otlp` connector (restore on disconnect); alternative location for a new backup: none exists yet.
- Decision: Desktop managed settings are detected only as a Linux file (`claude-desktop.paths.ts` comment explains macOS/Windows omitted).
- Data direction: `readClaudeSettingsEnv` stores a merged env (no provenance per key); the task needs per-file key presence and editability. Usual alternative: per-layer result list.
- Data: Desktop `inferenceModels` is already removed by `writeDesktopConfig` (:849, :998), covering brief 3.4 open check for that key.

### Task Statements Checked Against the Code

- "`readClaudeSettingsEnv` is only used by `claude-code-otlp.plugin.ts:121`" — holds (plus test mocks).
- "`flagState`/`effectiveEndpointEnv` private to routing.ts" — holds (routing.ts:101,120 no `export`).
- "`settings-conflict.ts` checks only ANTHROPIC_BASE_URL/ANTHROPIC_MODEL in user file, called at claude.plugin.ts:405" — holds. Keeps in place: `detectSettingsConflict` consumers `claude.plugin.ts:405`, two test files.
- "`managedSettingsPaths()` still lists ProgramData; lacks managed-settings.d, plists, registry" — holds (`claude-settings-env.ts:14-19`).
- "`writeDesktopConfig` writes without asking/backup and leaves `inferenceBedrock*`" — holds (no such key handling in `src`); it does delete `inferenceModels`.
- "`.codemie-backup` restored/deleted by `proxy disconnect`" — claude-code-otlp.ts:244 and surrounding restore logic present; holds for that connector (not independently traced through disconnect).
- "`resolveHook` skips agent's own `beforeRun` when wildcard hook exists" — brief states both-hooks case; code at lifecycle-helpers.ts:85-100 chains both when both exist, and returns only the specific hook when only that exists. Not fully verified against the Bedrock provider (its hooks registration not read); treat as unverified for the Bedrock profile case.
- "BaseAgentAdapter env from ...process.env (:603)" — holds; nothing strips Bedrock flag.
- "Claude Code precedence, `--setting-sources`, managed settings paths, VS Code extension behaviour, Desktop `inferenceProvider` values" — unverified (outside repository; brief cites binary source/live test; repro kit in `<workspace>/claude-bedrock-conflict/repro` would settle).
- "`install.ts` at :104 has no profile loaded" — holds in the region read (agent resolution only).

### Consumers of Changed Contracts

- `readClaudeSettingsEnv` / `settingsLayerPaths` / `managedSettingsPaths` (if moved or extended): `claude-code-otlp.plugin.ts:75,121`; `claude-settings-env.test.ts:5,32-73` (exact path arrays and `{env:{},complete:true}` equality at :46); mocks keyed on module path `../event-fields/claude-settings-env.js` in `claude-evidence-inputs.test.ts:10` and `routing-contract.test.ts:35` (relative mock path would break on a move).
- `flagState` / `effectiveEndpointEnv` (if exported/moved): internal callers `routing.ts:148,163,185,209-211`; tests `routing.test.ts`, `funding-route.test.ts`, `routing-contract.test.ts`.
- `detectSettingsConflict` (if folded/replaced): `claude.plugin.ts:405`, `settings-conflict.test.ts`, `claude.plugin.conflict.test.ts`.
- `writeDesktopConfig` / `buildGatewayConfig`: `desktop.ts` internal, `connect-orchestrator` Desktop path, `connectors/__tests__/desktop.test.ts` (asserts `inferenceModels` undefined at :630,:739).
- VS Code writer helpers (`writeAtomically` from `vscode.ts`): also used by `vscode-claude-code.ts` and `claude-code-otlp.ts:17`.
- Claude settings files written by CodeMie after the intended gate: skills sync (`BaseAgentAdapter.ts:~672`, `connect-orchestrator.ts:~953`), statusline in `claude.plugin.ts beforeRun`, OTLP endpoint refresh `claude-code-otlp-endpoint.ts:93` (brief locations; not each re-read).

### Architecture and Layers Affected

CLI layer (`AgentCLI.handleRun`, `install.ts`, `proxy/connect-orchestrator.ts`), agent plugin layer (`agents/plugins/claude/`, `claude-code-otlp/event-fields`), core evidence (`agents/core/evidence/routing.ts`), connector layer (`proxy/connectors/desktop.ts`, `vscode-claude-code.ts`), utils (`interactive.ts`, `paths.ts`).

### Integration Points

- Claude Code settings files (user, project, project-local, managed), Claude Desktop `configLibrary`, VS Code `User/settings.json`, shell env; local filesystem only. No network or DB.

### Patterns and Conventions

- Inquirer prompts with injectable deps; ESM `.js` imports; `logger` + `sanitizeLogArgs` (never log setting values; brief 6); `ConfigurationError`; `getCodemiePath()` for `~/.codemie`; atomic writes via `writeAtomically`; platform/path injection as in `claude-settings-env.ts` function signatures (`platform`, `env`, `cwd` params).

---

## 3. Documentation Findings

### Guides and Architecture Docs
`.ai-run/guides/` exists (architecture, development, integration, security, standards, testing, usage, quality-gates, project). Read: `testing/testing-patterns.md` (Vitest, co-located `__tests__`, nested describe, dynamic imports after mocks). Others (architecture 5-layer `CLI -> Registry -> Plugin`, security-practices, development-practices) are named by AGENTS.md and not re-read here. No guide covers Claude settings conflicts.

### Architectural Decisions
No ADR on this topic found in the files read. `docs/ARCHITECTURE-OTLP-PLUGIN.md` covers the OTLP adapter, not settings conflicts.

### Derived Conventions
See Section 2 Patterns. AGENTS.md: tests only on explicit request (here required by AC 10); no git operations unless asked; no ticket IDs in repo.

---

## 4. Testing Landscape

### Existing Coverage
- `claude-code-otlp/__tests__/claude-settings-env.test.ts` (real tmp dirs, injected platform), `claude/__tests__/settings-conflict.test.ts` (fs mocked), `claude.plugin.conflict.test.ts`, `core/evidence/__tests__/routing*.test.ts`, `connectors/__tests__/desktop.test.ts`, `core/__tests__/AgentCLI-*.test.ts` (silent flag, project seam, print-config), `cli/commands/__tests__/install.version-selection.test.ts`, `proxy/prompts/__tests__`, `launch-identity.test.ts`.

### Testing Framework and Patterns
Vitest (projects config `vitest.config.ts`: unit `src/**/*.test.ts`, `CODEMIE_HOME` set to a temp dir), `vi.mock('fs')`/`vi.mock('fs/promises')`, `vi.resetModules()` + dynamic import, injectable prompt deps (`launch-project-prompt.ts`), real tmp-dir tests with injected platform/env for settings layers. Integration tests under `tests/integration`.

### Coverage Gaps
No tests for backup folders, Bedrock detection, managed-settings.d, plist/registry readers, Desktop `inferenceBedrock*`, VS Code `claudeCode.environmentVariables` Bedrock keys, or for `install.ts`/`connect-orchestrator` Claude pre-write gates. No `AgentCLI` test seam exists for a Claude settings gate (closest: `AgentCLI-project-seam.test.ts`).

---

## 5. Configuration and Environment

### Environment Variables
`CLAUDE_CONFIG_DIR`, `CLAUDE_PROJECT_DIR` (read by `settingsLayerPaths`); `CODEMIE_NO_PROMPTS=1` (`interactive.ts:25`); `CODEMIE_HOME` (via `getCodemieHome`); `CLAUDE_CODE_USE_BEDROCK` and AWS keys (Claude's, see routing.ts); `CODEMIE_DEBUG`.

### Configuration Files
`~/.claude/settings.json`, `<project>/.claude/settings(.local).json`, managed paths per `managedSettingsPaths`, Desktop `configLibrary/_meta.json` + `<id>.json`, VS Code `User/settings.json` (stable/Insiders), CodeMie profiles via `ConfigLoader`.

### Feature Flags and Deployment Concerns
None found for this area. Cross-platform concerns (Windows registry, file locking, macOS plists) are not exercised by existing code beyond path tables.

---

## 6. Risk Indicators

- `claude-settings-env.ts` has three behavioural gaps vs the brief (no per-layer provenance, malformed = unreadable, no managed-settings.d/plist/registry); changing malformed-file semantics changes `complete` for its only production caller (`claude-code-otlp.plugin.ts:121`) and its tests (`claude-settings-env.test.ts:46,64`).
- Two tests mock `claude-settings-env.js` by relative path; relocating the module requires updating them (`claude-evidence-inputs.test.ts:10`, `routing-contract.test.ts:35`).
- `detectSettingsConflict` (ANTHROPIC_BASE_URL/MODEL warning) and the new Bedrock gate address related settings.json problems; existing mechanism stays in place if untouched (consumers: `claude.plugin.ts:405`, 2 test files). See Section 2 Existing Implementations.
- `writeDesktopConfig` overwrites unparseable configs with `{}` and has no backup hook; a backup must be taken by a caller before it runs.
- Gate ordering: three entry points with different "first write" positions (brief 7); `AgentCLI.handleRun` has several `process.exit(1)` and prompt points before `validateCompatibility`; a gate placed after SSO auth may start a sign-in before a cancel.
- Brief's claim about `resolveHook` for the Bedrock profile not independently verified (hook registration for Bedrock not read).
- Speculative: shared project `.claude/settings.json` edits can touch git-tracked files; backup must live outside the repo (brief decision).
- Speculative: Windows registry/plist readers need injectable shell-outs (`plutil`, `reg query`), no existing helper found; `src/utils/exec.ts` is the sanctioned exec wrapper per AGENTS.md.
- Speculative: key-removal list includes `AWS_PROFILE`/`AWS_REGION` and model keys, which can also serve non-Bedrock use in the same file; the brief says confirm in spec (static AWS creds default, "model-list settings" meaning).
- Unverified external behaviour (Claude precedence, Desktop Code tab, VS Code extension, Windows) rests on the brief's tests; QA-only items listed in brief 11.
- Large surface: ~3 entry points, 4 editable file families, 2 non-editable, prompt, backup+manifest, ACP/non-interactive paths, and tests for each.

---

## 7. Summary for Complexity Assessment

Layers touched: CLI (`AgentCLI.handleRun`, `install.ts`, `connect-orchestrator.ts`), core evidence/settings reading (`claude-settings-env.ts`, `routing.ts` exports), connectors (`desktop.ts`, `vscode-claude-code.ts`), plus utils (interactive/paths). The change surface is likely a new module family (resolver, planner/switcher with backup manifest, prompt) plus three hook-ups and edits to two existing shared modules; roughly 8-15 files including tests. Nothing in the repo today detects Bedrock in Claude settings, backs up under `~/.codemie`, or reads managed-settings.d, macOS plists or the Windows registry.

Technical novelty is moderate: JSONC editing, Desktop config and inquirer prompting have in-repo precedents (`vscode-claude-code.ts`, `desktop.ts`, `launch-project-prompt.ts`); platform-specific managed-source readers and a multi-file backup/manifest have none. Existing tests for settings reading use real tmp dirs with injected platform/env, which fits the injectable-path requirement; the entry points (`AgentCLI`, `install`, `connect-orchestrator`) have few seams for a pre-write gate test.

Main risks: shared-module semantics change (malformed file handling, moved imports under mocks), gate ordering across three flows, cross-platform managed-source detection that cannot be tested locally, and external Claude behaviour that is only verified through the brief's repro results. Test coverage for the target behaviour is currently nil; AC 10 requires it.

---

## 8. External References

Resolved: `<workspace>/claude-bedrock-conflict/brief.md` (read in full). Repro kit `<workspace>/claude-bedrock-conflict/repro/` (listed: `scripts/mock.mjs`, `run-case.sh`, `run-raw.sh`, `real-settings-test.sh`, `override*.json`, `s-comment.json`, `s-trailing.json`, `work/`; not run). The Jira URL was not fetched (brief is the stated source).

Facts the spec needs from the brief:
- ACs 1-10 (AC 11 docs out of scope): detect Bedrock before any CodeMie write in `codemie install claude`, `codemie-claude` (+ACP), and Claude `proxy connect` targets; message says Bedrock and gateway cannot both be active; cancel changes nothing and exits with guidance; switch backs up first, then removes Bedrock flag, AWS profile settings and Bedrock model settings; unrelated settings kept; unreadable file = stop (AC 7); malformed JSON in Claude Code settings = not in effect (skip/warn).
- Precedence: managed > `--settings` > project local > project > user settings > process env. Remove keys from every editable layer.
- Sources table: user settings, project local, project (shared), managed (explain+exit), shell env (`codemie-claude` strips `CLAUDE_CODE_USE_BEDROCK` silently; other flows warn), VS Code `claudeCode.environmentVariables`, Desktop `configLibrary/<appliedId>.json` (`inferenceProvider: "bedrock"`; strip `inferenceBedrock*`, switch to gateway), Desktop managed.
- Keys: `env` `CLAUDE_CODE_USE_BEDROCK`, `ANTHROPIC_BEDROCK_BASE_URL`, `CLAUDE_CODE_SKIP_BEDROCK_AUTH`, `AWS_BEARER_TOKEN_BEDROCK`, `AWS_PROFILE`, `AWS_REGION`, `AWS_DEFAULT_REGION`; default also `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`; top-level `awsAuthRefresh`, `awsCredentialExport`; Bedrock-ID model keys (`model`, `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`, Bedrock entries of `availableModels`).
- Decisions: ask every time; ACP and non-interactive never prompt, stop with guidance; backups `~/.codemie/backups/bedrock-switch-<timestamp>/` with `manifest.json`, never overwrite; cancel exit code 1; skip check when active profile provider is `bedrock`; `--claude-code-otlp` only warns; `codemie install claude` with no profile skips; Bedrock only (Vertex/Foundry follow-up); no ticket IDs or customer name in the repo.
- Placement: `AgentCLI.handleRun` after `validateCompatibility` (brief says ideally before the auth step); `install.ts` ~:104; `connect-orchestrator.ts` near :887-907 and before skills sync (:953-956); not in `claude.plugin.ts beforeRun`.

## Facts Added by Review

Researched for the names the spec relies on, after the analysis above was written. Read like the facts layer; where a line here contradicts one above, this one was read later.

- `codemie-claude` does NOT go through `bin/codemie.js`: `bin/codemie-claude.js` imports `dist/agents/core/AgentCLI.js` and runs `AgentCLI(AgentRegistry.getAgent('claude')).run(process.argv)`, reaching `AgentCLI.handleRun` (`src/agents/core/AgentCLI.ts:182`, default action at line 115) directly. It skips migrations, the update check and the what's-new notice.
- `codemie install` (`src/cli/commands/install.ts:18`, action line 28) and `codemie proxy connect` (`src/cli/commands/proxy/index.ts`, `connectTargets` at `connect-orchestrator.ts:834`) run only after `bin/codemie.js` start-up work.
- Other references to `bin/codemie.js`: `src/utils/scheduled-run.ts`, `src/utils/hook-command.ts:76`, `src/cli/commands/proxy/connectors/copilot-cli-otlp.ts:63`, `src/utils/cli-bin.ts:57-64`, `src/utils/cli-updater.ts:369`, `src/utils/whatsnew.ts:7`.
- Start-up migrations (`src/migrations/` 001-011, tracked once in `~/.codemie/migrations.json`) run from `bin/codemie.js:51` before any `codemie` subcommand, including `install` and `proxy connect`. Those writing Claude files: 005 (skill slugs in `~/.claude/skills` and local `.claude/skills`), 009 (OTLP `UserPromptSubmit` hook timeout in `~/.claude/settings.json`), 011 (OTLP hook commands in `~/.claude/settings.json`). A `codemie-claude` launch never triggers them. A gate placed in `install.ts` or `connect-orchestrator.ts` therefore does not precede them (consistent with the spec's non-goal of gating startup migrations).
