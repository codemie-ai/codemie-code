# Technical Research

**Task**: codemie-code CLI opencode plugin XDG_CONFIG_HOME XDG_DATA_HOME isolation beforeRun getOpenCodeConfigDir (EPMCDME-16963)
**Generated**: 2026-11-19
**Research path**: filesystem
**Workspace root**: C:\code\codemie-dev
**Repositories**: `codemie-code` (C:\code\codemie-dev\codemie-code, HEAD 709f0e6d, 2026-11-18) — **affected**

---

## 1. Original Context

Jira EPMCDME-16963 (Bug, repository codemie-code at C:\code\codemie-dev\codemie-code). `codemie --task "..."` and `codemie-code --task "..."` crash with `Cannot find module '@opencode-ai/plugin' from 'C:\Users\<user>\.config\opencode\tool\<file>.ts'`.
Root cause (per ticket, confirmed on main @ HEAD): `beforeRun` in `src/agents/plugins/codemie-code.plugin.ts` (~line 359) sets `XDG_DATA_HOME` but does not isolate `XDG_CONFIG_HOME`. `getOpenCodeConfigDir()` in `src/agents/plugins/opencode/opencode.paths.ts` (~line 250) falls back to the real global `~/.config/opencode` when `XDG_CONFIG_HOME` is unset. Any broken/custom tool file in `~/.config/opencode/tool/*.ts` is auto-loaded by the embedded OpenCode engine and crashes every `--task` run.
Repro: place a custom/broken OpenCode tool file under ~/.config/opencode/tool/ referencing `@opencode-ai/plugin`; run `codemie --task "<prompt>"` or `codemie-code --task "<prompt>"`; observe crash.
Out of scope: bare positional task text treated as a `cd` target (fixed in commit 42cde9c5 / PR #322).
Suggested fix: have `beforeRun` also set `XDG_CONFIG_HOME` to an isolated CodeMie-owned directory, mirroring the existing `XDG_DATA_HOME` isolation.
Reference: https://github.com/codemie-ai/codemie-code/issues/251
No acceptance criteria in the ticket; no comments.
(Plus the requester's research questions: verify root-cause claims and line numbers; all other readers of OpenCode config via XDG_CONFIG_HOME / ~/.config/opencode; whether user OpenCode config is relied upon; existing tests for beforeRun / opencode.paths; risks to user global config, the `codemie-opencode` agent, auth, interactive mode, child env propagation, cleanup/afterRun.)

---

## 2. Codebase Findings

Impact: `codemie-code:` **affected** (only repo in scope; no other repo read).

### Existing Implementations

**Purpose A — keep the embedded OpenCode engine of `codemie-code` from loading the user's global OpenCode config/tools.**
- `codemie-code:src/agents/plugins/codemie-code.plugin.ts:363` — `env.XDG_DATA_HOME = getOpenCodeStorageBase()` inside `lifecycle.beforeRun` (ticket's "~359" is actually 363; comment block 358-362). Only isolation present. `getOpenCodeStorageBase()` = `join(getCodemieHome(), 'opencode-storage')` (`opencode.paths.ts:17-19`), honours `CODEMIE_HOME` (`src/utils/paths.ts:367-373`). Result: data (sessions, `opencode.db`, and by OpenCode convention auth) live under `~/.codemie/opencode-storage/opencode/`.
- No `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME` or `OPENCODE_CONFIG_DIR` is set anywhere in `src` for `codemie-code` (grep of whole repo; only `opencode.paths.ts:250` reads `XDG_CONFIG_HOME` for OpenCode).
- `codemie-code.plugin.ts:368-383` — provider/model config is injected via `OPENCODE_CONFIG_CONTENT` (or `OPENCODE_CONFIG` temp file above `MAX_ENV_SIZE`). This is an *overlay*; it does not replace global-dir loading. Plugins injected by file URL from `<tmpdir>/codemie-hooks/` (`src/agents/core/plugin-injector.ts:7,49-60`): `shell-hooks.ts`, `reasoning-sanitizer.ts` (both `import type ... from "@opencode-ai/plugin"`, erased types: `reasoning-sanitizer-source.ts:18`, `shell-hooks-source.ts:346`).
- Engine behaviour evidence (installed binary `@codemieai/codemie-opencode@0.0.47`, `codemie.exe`, string scan only, no source in reach): binary contains the literals `XDG_CONFIG_HOME` (x6), `OPENCODE_CONFIG_DIR` (x26), `OPENCODE_DISABLE_PROJECT_CONFIG`, `OPENCODE_DISABLE_DEFAULT_PLUGINS`. Local `~/.config/opencode/package.json` holds `{"dependencies":{"@opencode-ai/plugin":"0.0.47"}}` plus `node_modules/` — i.e. the engine itself installs `@opencode-ai/plugin` into its config dir; a `tool/*.ts` file there resolves the module from that dir. Whether an empty isolated config dir triggers the same self-install (network, first-run) is **unverified**.

**Purpose B — resolve OpenCode config locations for the *plain* `opencode` agent (MCP/extension analytics).**
- `opencode.paths.ts:249-254` `getOpenCodeConfigDir()` — `$XDG_CONFIG_HOME/opencode` else `homedir()/.config/opencode` (same on Windows: `C:\Users\<u>\.config\opencode`, no `%APPDATA%` branch; matches the path in the ticket's error). Line ~250 claim holds.
- Only consumers (grep of `getOpenCodeConfigDir`): `opencode/opencode.plugin.ts:14` import; `:204-205` (`mcpConfig.user.path`, plus `~/.opencode/opencode.json`); `:220` (`extensionsConfig.global`). All three are evaluated **at module load** in the `OpenCodePluginMetadata` object literal, so a later `process.env` mutation does not change them. `codemie-code`'s metadata declares **no** `mcpConfig`/`extensionsConfig` (`codemie-code.plugin.ts:193-457`).
- Downstream scanners of those fields: `src/utils/mcp-config.ts:206` (`mcpConfig.user`), `src/utils/extensions-scan.ts:221-222` (`extensionsConfig.global`/`extraGlobalDirs`). Both read the declared paths only.

**Purpose C — locate session data for analytics of both agents.**
- `opencode.paths.ts:14` `USER_XDG_DATA_HOME` captured at load, with comment (lines 10-13) that a codemie-code launch later repoints this process's `XDG_DATA_HOME` — the precedent for "wrapper process env gets mutated". `getAgentOpenCodeStoragePath(agentName)` (`:25-32`): `codemie-code` → CodeMie storage; `opencode`/`opencode-acp` → user's XDG_DATA_HOME or platform default. Consumer `opencode.run-session.ts:12,156`.
- Lazy readers of `process.env.XDG_DATA_HOME`: `getOpenCodeStoragePath` (`:148`), `getOpenCodeDataDir` (`:193`) → used by `opencode.session.ts`, `opencode-metrics.ts:28-29`, `opencode.plugin.ts:335`. `XDG_CONFIG_HOME` has **no** equivalent load-time capture.

**Other touched code**
- `src/agents/core/BaseAgentAdapter.ts:680` `executeBeforeRun`; `:700` `Object.assign(process.env, env)` (wrapper's own env receives every `beforeRun` var); `:933-938` `spawn(..., { env })` passes the same env to the child; `:949-1029` `onSessionEnd` then `executeAfterRun`. `codemie-code` defines **no** `afterRun`; its `onSessionEnd` (`:412-455`) only runs `processEvent` and `cleanupHooksPlugin()/cleanupReasoningSanitizerPlugin()`.
- `codemie-code.plugin.ts:258-265` — `beforeRun` **returns early** when `CODEMIE_BASE_URL` is empty/invalid, *before* line 363, so `XDG_DATA_HOME` (and anything added beside it) is not set in that case. `beforeRun` is not conditioned on `--task`; the TUI path runs the same code (`enrichArgs` `:386-410` only decides `run` vs bare).
- `opencode.plugin.ts:315-487` — plain `opencode` agent's `beforeRun`; sets no XDG var; pinned by test (below). "codemie-opencode" in the ticket maps to this agent (`bin/codemie-opencode.js`, `package.json:15`) and also to the npm package `@codemieai/codemie-opencode` (the `codemie-code` engine).

### Decisions Already in the Code
- `codemie-code` isolates OpenCode **data** from the user's OpenCode install; `opencode` agent deliberately does not — `opencode-session-lifecycle.test.ts:310-317` ("Redirecting it would orphan the session history users already have"). Reason for the codemie-code side: "a location we can discover" (`codemie-code.plugin.ts:359-362`). Alternative not taken: `OPENCODE_CONFIG_DIR`. No recorded reason for leaving config unisolated; none found.
- Convention: CodeMie-owned dirs derive from `getCodemieHome()`/`getCodemiePath()` (AGENTS.md "Hardcoded `~/.codemie` paths" pitfall; `openwiki/concepts/configuration-and-local-state.md:39`). Env set in `beforeRun` goes on the `env` arg (returned) — not `process.env` directly.
- Config path functions in this area read `process.env` lazily, except the `USER_XDG_DATA_HOME` load-time capture; metadata path fields use load-time values.
- Windows vs POSIX: `getOpenCodeConfigDir` has no platform branch; data-dir helper `platformOpenCodeDataDir` (`opencode.paths.ts:34-48`) does (macOS `Library/Application Support`, win32 `%LOCALAPPDATA%`). `spawn` uses `shell: isWindows` (`BaseAgentAdapter.ts:936`).

### Task Statements Checked Against the Code
- "`beforeRun` ... sets `XDG_DATA_HOME` but does not isolate `XDG_CONFIG_HOME`" — **holds** (`codemie-code.plugin.ts:363`; no XDG_CONFIG_HOME write anywhere in `src`). Line "~359" is **363** at HEAD.
- "`getOpenCodeConfigDir()` ... (~line 250) falls back to the real `~/.config/opencode`" — **holds** (`opencode.paths.ts:249-254`). But it is **not on the `codemie-code` runtime path**: its only callers are the plain `opencode` agent's metadata (see Purpose B). The engine, not this function, loads `tool/*.ts`.
- "Any broken tool file in `~/.config/opencode/tool/*.ts` is auto-loaded by the embedded engine" — **unverified** in-repo: engine source not in reach; installed 0.0.47 binary contains `XDG_CONFIG_HOME` and `OPENCODE_CONFIG_DIR` strings, consistent with it. Local `~/.config/opencode` has no `tool/` dir, so the crash was not reproduced (read-only task).
- "Suggested fix: mirror the existing `XDG_DATA_HOME` isolation" — **keeps in place**: the `OPENCODE_CONFIG_CONTENT` overlay and `OPENCODE_CONFIG` fallback (`:368-383`); user-level `opencode.json`/agents/commands/MCP in the global dir are currently merged by the engine for `codemie-code` runs (no in-repo test or doc asserts this; none found either way).
- "Out of scope: ... fixed in 42cde9c5 / PR #322" — **holds**: `42cde9c5` is in history (`fix(agents): treat bare positional args as run task in codemie-code (#322)`), `enrichArgs` `:403-408`.
- "Reference issue #251" — **unverified** (external).
- "`--task` runs crash" — `beforeRun` is shared, so the same exposure exists for interactive `codemie-code` (**holds** by code reading; not stated in ticket).

### Consumers of Changed Contracts
The changed contract is the env that `codemie-code`'s `beforeRun` returns (`XDG_CONFIG_HOME`) and, via `Object.assign(process.env, env)` (`BaseAgentAdapter.ts:700`), the wrapper's own `process.env`.
- Child engine (`spawn env`, `:933`) — gets a different global config dir: loses user `opencode.json`, `agent/`, `command/`, `tool/`, `plugin/`, `package.json`+`node_modules` of the real global dir.
- `opencode.paths.ts:250` `getOpenCodeConfigDir()` — would return the isolated dir if called after `beforeRun` in the same process; current callers all evaluate at load (`opencode.plugin.ts:204,205,220`), so unaffected.
- `claude-desktop.paths.ts:27` (Linux only; lazy read) → `DesktopTelemetryRuntime.ts:30`, `DesktopRepositoryResolver.ts:20`, `CoworkEventProducer.ts:34`, `claude-desktop.gateway.ts:11`, `claude-desktop.discovery.ts:12`, `proxy/connectors/desktop.ts:8`, `proxy/inspect-desktop.ts:15`, `proxy/analytics-clients.ts:12`; and `proxy/connectors/vscode.ts:111` (`XDG_CONFIG_HOME ?? ~/.config`). They read `process.env.XDG_CONFIG_HOME` lazily; whether any runs in the `codemie-code` wrapper process after `beforeRun` was not established (they live in the proxy/telemetry runtime and `proxy` CLI commands).
- Child processes spawned by the engine (MCP servers, `codemie hook` via OPENCODE_HOOKS command) inherit the child env, hence the same `XDG_CONFIG_HOME`; hook command is `codemie hook` (`buildDefaultHooks`, `:30-36`) which itself reads CodeMie home, not XDG config.
- Tests/docs: none assert `XDG_CONFIG_HOME` for OpenCode (see Section 4); no doc mentions `~/.config/opencode` (grep README, docs, openwiki, guides).

### Architecture and Layers Affected
Agent plugin layer (`src/agents/plugins/codemie-code.plugin.ts` lifecycle `beforeRun`), OpenCode path helpers (`src/agents/plugins/opencode/opencode.paths.ts`), and the shared adapter `BaseAgentAdapter` (env merge/spawn; unchanged but the propagation path).

### Integration Points
- CLI → `AgentRegistry` → `CodeMieCodePlugin` → `BaseAgentAdapter.run()` → `setupProxy()` → `beforeRun` → `spawn(codemie-opencode binary)` (`codemie-code.plugin.ts:179` flow comment).
- External: `@codemieai/codemie-opencode@0.0.47` (`package.json:124`, `CODEMIE_CODE_SUPPORTED_VERSION` `:39`), resolved in `codemie-code-binary.ts`; `@opencode-ai/plugin` is only referenced as a type import in injected plugin sources.

### Patterns and Conventions
Lifecycle hooks mutate/return `env` (`AgentLifecycle`); path helpers live in `opencode.paths.ts` with `getCodemieHome()`; ESM `.js` import suffixes; `logger.debug` for env decisions (`:365`); plugin-sourced temp files under `<tmpdir>/codemie-hooks` with process-exit cleanup (`plugin-injector.ts`).

---

## 3. Documentation Findings

### Guides and Architecture Docs
`.ai-run/guides/` exists (architecture, development, testing, usage, integration, security, standards). None mentions OpenCode config dirs or XDG. `openwiki/concepts/configuration-and-local-state.md:39` covers `CODEMIE_HOME`/`getCodemiePath`. `docs/superpowers/tasks/2026-07-07-analytics-exclude-external-sessions/technical-analysis.md:361` notes XDG vars as "standard XDG fallbacks used by OpenCode's storage/config"; `.../2026-07-10-epmcdme-12737-windows-special-char-path/technical-analysis.md:81,167` records that `XDG_DATA_HOME` is an env var (not shell-parsed) on Windows.

### Architectural Decisions
None recorded for config-dir isolation. Inline NOTE in `opencode.plugin.ts:172` and `opencode.paths.ts:10-13` describe data storage only.

### Derived Conventions
CodeMie-owned state under `getCodemieHome()`; `beforeRun` returns the env it was given; `process.env` is also mutated by the adapter (`:700`).

---

## 4. Testing Landscape

### Existing Coverage
- `src/agents/plugins/__tests__/codemie-code-plugin.test.ts` — metadata, `beforeRun` model catalogue (`:158-172`, uses `.catch(() => undefined)` because env is thin), install/uninstall, session start/end. Mocks `utils/paths.js` (`getCodemieHome` → `/mock/.codemie`), `fs`, hooks injectors. **No assertion on `XDG_DATA_HOME`.** Siblings: `codemie-code-reasoning.test.ts` (parses `OPENCODE_CONFIG_CONTENT`), `codemie-code.hooks.test.ts`, `codemie-code.plugin.version-support.test.ts`.
- `src/agents/plugins/opencode/__tests__/opencode-session-lifecycle.test.ts:244-318` — plain `opencode` `beforeRun`; `:310-317` asserts `env.XDG_DATA_HOME` is `undefined`; `:370-384` pins `mcpConfig`/`extensionsConfig` shape (not the global paths).
- `opencode.locate-transcript.test.ts:17-23,86-96` stubs `process.env.XDG_DATA_HOME`; `opencode.run-session.test.ts:220-282` uses `codemie/opencode-storage/opencode/` layout.
- `tests/integration/agent-task-session.test.ts`, `agent-resume-codemie-id.test.ts` exercise `--task` sessions (use `CODEMIE_HOME`); no XDG config assertions.

### Testing Framework and Patterns
Vitest; `vi.mock` of `paths.js`/`fs`/injectors; dynamic imports after mocks; `baseEnv()` fixtures; `vi.stubEnv` for XDG vars (many Claude Desktop/proxy tests, e.g. `desktop.test.ts:121-179`). Tests only on explicit request (AGENTS.md).

### Coverage Gaps
- No `opencode.paths` unit test file (glob: none); `getOpenCodeConfigDir` untested.
- `codemie-code` `beforeRun` XDG behaviour untested (data or config), including the early-return branches (`:258-265`).
- No test of onSessionEnd/cleanup relative to any config dir.

---

## 5. Configuration and Environment

### Environment Variables
- `XDG_DATA_HOME` — set by codemie-code `beforeRun` (`:363`); read lazily in `opencode.paths.ts:148,193`; captured at load as `USER_XDG_DATA_HOME` (`:14`).
- `XDG_CONFIG_HOME` — read at `opencode.paths.ts:250`; also by Claude Desktop/VS Code path helpers (Section 2).
- `CODEMIE_HOME` — relocates CodeMie home (`utils/paths.ts:368`); `OPENCODE_STORAGE_PATH` — storage override (`opencode.paths.ts:141,188`).
- `OPENCODE_CONFIG_CONTENT` / `OPENCODE_CONFIG` / `OPENCODE_DISABLE_SHARE` / `OPENCODE_HOOKS` — set by `beforeRun`. `OPENCODE_CONFIG_DIR` — present in engine binary, not used by this repo.
- `XDG_STATE_HOME`, `XDG_CACHE_HOME` — not referenced anywhere in `src`.

### Configuration Files
`~/.codemie/codemie-cli.config.json` (profiles); OpenCode global `~/.config/opencode/{opencode.json,package.json,node_modules,tool/,plugins/}` (outside repo; local machine has `opencode.json`, `package.json`, `node_modules`, `plugins`, no `tool`). `config.example.json` n/a.

### Feature Flags and Deployment Concerns
No flags. Installation via `installGlobal('@codemieai/codemie-opencode')` / `uninstallGlobal` (`codemie-code.plugin.ts:484-515`) touches npm packages only; neither install nor uninstall reads or removes `~/.codemie/opencode-storage` or any config dir (none found). `bin/codemie.js` / `bin/agent-executor.js` entry points.

---

## 6. Risk Indicators

- Root-cause line refs drift: `beforeRun` XDG line is 363 (ticket ~359); `getOpenCodeConfigDir` is 249-254 (matches). The cited function is not on the `codemie-code` run path (only `opencode` agent metadata) — the actual loader is the external engine (unverified source).
- Existing mechanism kept in place (see Task Statements): global-dir user config (`opencode.json`, agents, commands, MCP) currently merges into `codemie-code` runs; consumers are users of that behaviour, undocumented and untested in repo.
- Speculative: an isolated, empty config dir has no `node_modules/@opencode-ai/plugin`; the engine's self-install (seen in local `~/.config/opencode/package.json`) may need network on first run or fail offline/corporate proxy.
- Speculative: the same early return (`:258-265`) that skips `XDG_DATA_HOME` would skip a new `XDG_CONFIG_HOME` set beside it; `--task` runs without `CODEMIE_BASE_URL` remain exposed.
- Speculative: `Object.assign(process.env, env)` (`BaseAgentAdapter.ts:700`) would leak the isolated `XDG_CONFIG_HOME` into the wrapper process; lazy readers of it on Linux (Claude Desktop/VS Code helpers) could see the changed value; Windows has no XDG reader in these paths except engine/`getOpenCodeConfigDir`.
- Speculative: interactive `codemie-code` (TUI) shares `beforeRun`, so any change alters it too; `XDG_STATE_HOME`/`XDG_CACHE_HOME` (model recents, cache) stay unisolated.
- Auth: OpenCode credentials live under the data dir, already isolated by `XDG_DATA_HOME`; config isolation does not appear to touch auth (engine behaviour unverified).
- `opencode`/`opencode-acp` must stay untouched: test `opencode-session-lifecycle.test.ts:310-317` pins no XDG redirect for data; no equivalent pin for config yet.
- Test gaps: no `opencode.paths` tests; codemie-code `beforeRun` env isolation untested; thin env in existing test forces `.catch` (`codemie-code-plugin.test.ts:168`).
- Reproduction not possible read-only here (no `tool/` dir locally); crash relies on engine semantics.

---

## 7. Summary for Complexity Assessment

The bug sits in one lifecycle hook, `CodeMieCodePluginMetadata.lifecycle.beforeRun` (`codemie-code.plugin.ts:363`), which isolates only `XDG_DATA_HOME`. Claims verified: `XDG_CONFIG_HOME` is never set for `codemie-code` anywhere in `src`; `getOpenCodeConfigDir` is at `opencode.paths.ts:249-254` but is only used by the plain `opencode` agent's load-time metadata, so it is not what causes the crash — the embedded engine resolves its global config dir itself from the child env, which `BaseAgentAdapter` builds from `beforeRun`'s return value. Layers touched: agent plugin lifecycle and (optionally) OpenCode path helpers; the adapter is only the propagation path (env spawn at `:933`, `process.env` merge at `:700`, no `afterRun` for this plugin).

Technical novelty is low: a precedent (`XDG_DATA_HOME` + `getOpenCodeStorageBase`) exists in the same function, with a `CODEMIE_HOME`-aware helper convention. Uncertainty is behavioural, not structural: engine loading/self-install semantics in an empty config dir, and the early-return branch that precedes the XDG assignment, are not verifiable from this repository. Windows and POSIX use the same `~/.config` default for config; data dir has per-platform defaults but those apply only to the `opencode` agent.

Test posture is thin: no `opencode.paths` tests, no assertion of `XDG_DATA_HOME` for `codemie-code`, and `codemie-code-plugin.test.ts` mocks `paths.js`/`fs` heavily. A sibling test pins the opposite behaviour for the `opencode` agent. Key risk factors: loss of user global OpenCode config for `codemie-code` runs (undocumented but currently effective), first-run dependency install in the isolated dir, shared `beforeRun` for TUI and `--task`, and lazy `XDG_CONFIG_HOME` readers elsewhere on Linux.

---

## 8. External References

None named by the task as a source of truth other than the GitHub issue URL `https://github.com/codemie-ai/codemie-code/issues/251` — not fetched (no network access/read-only scope): **unresolved**. Local evidence consulted instead: installed `@codemieai/codemie-opencode@0.0.47` Windows binary (string scan) at `C:\Users\AliaksandrTarasevich\.npm-global\node_modules\@codemieai\code\node_modules\@codemieai\codemie-opencode-windows-x64\bin\codemie.exe`, and the local `~/.config/opencode/package.json` (dependency `@opencode-ai/plugin` 0.0.47).
