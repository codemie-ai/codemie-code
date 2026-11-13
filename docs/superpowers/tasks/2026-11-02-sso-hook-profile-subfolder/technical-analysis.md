# Technical Research

**Task**: sso hook ensureProxyAuth ConfigLoader profile (EPMCDME-16308)
**Generated**: 2026-11-02
**Research path**: filesystem (codegraph MCP tool not available; 1 orientation agent + 4 parallel Explore threads)

---

## 1. Original Context

task_context (verbatim ticket EPMCDME-16308):

[CodeMie CLI][SSO] Production Claude Code session opens Preview login and blocks prompts after switching to a subfolder.
Component: CodeMie CLI / SSO. CLI Version 0.16.0.

Description: A Claude Code session was started from ~/Projects/control-plane using the Production profile `control plane` and worked correctly. During the session, Opus moved into the `cli-analytics-smoke` subfolder. When the next prompt was submitted, the SSO hook unexpectedly selected the global Preview profile `standalone-qa` instead of the original Production profile. The prompt was blocked ("CodeMie SSO authentication is invalid") and the browser opened the Preview SSO login page. The Production proxy remained healthy and continued using `control plane`.

Steps: 1. Configure local Production profile `control plane` and global Preview profile `standalone-qa`. 2. Start Claude Code from ~/Projects/control-plane with --profile "control plane". 3. Execute a prompt successfully. 4. Change the session's working directory to a subfolder. 5. Submit another prompt.

Expected: The SSO hook should continue using the Production profile selected when the session started, even in repository subdirectories. If re-authentication is required, it must open the correct environment.

Confirmed root cause (per ticket, verify it): `ensureProxyAuth()` reloads the profile using `ConfigLoader.load(process.cwd())` instead of the session's selected profile. The config lookup does not search parent directories, so inside a subfolder it falls back to the global Preview profile.

Acceptance criteria:
1. SSO validation uses the same profile as the active Claude Code session.
2. Explicit --profile selection is preserved.
3. Moving between repository subdirectories does not change the authentication environment.
4. Production sessions never open Preview SSO unexpectedly.
5. Regression tests cover nested directories and different local/global profiles.

---

## 2. Codebase Findings

### Root-cause verdict: CONFIRMED (with one refinement)

- `ensureProxyAuth()` is a private method on three OTLP plugins, not in `hook.ts`. All three call `ConfigLoader.load(process.cwd())` with no `{ name }` override:
  - `src/agents/plugins/claude-code-otlp/claude-code-otlp.plugin.ts:438-454` (the ticket's case). Sole caller: `onUserPromptSubmit` at `:456-483` (line 457). On failure it blocks the prompt with `describeLogin(...)` plus `(${authResult.reason})`. Uses `ensureCodeMieSsoAuthOrWait` (wait up to `SSO_LOGIN_WAIT_MS` 150s, clamped to the installed hook timeout via `readPromptHookTimeoutSeconds`).
  - `src/agents/plugins/copilot-cli-otlp/copilot-cli-otlp.plugin.ts:260-268` (callers at :104 and :129). Uses `ensureCodeMieSsoAuth` (no wait).
  - `src/agents/plugins/copilot-chat-otlp/copilot-chat-otlp.plugin.ts:187-195` (same shape).
- `ConfigLoader` (`src/utils/config.ts`):
  - `load(workingDir, cliOverrides)` at `:92-202`.
  - Local config path is `path.join(workingDir, '.codemie/codemie-cli.config.json')` (`LOCAL_CONFIG`, `:63`). Global path is `getCodemiePath('codemie-cli.config.json')`.
  - Parent directories are NOT searched. Every local lookup uses the exact `workingDir`: `resolveProfileName` (`:378-394`), `resolveLocalProfileName` (`:407-438`), `loadLocalConfigProfile` (`:336-369`), `getActiveProfileName` (`:892`), `hasLocalConfig` (`:1106`).
  - Profile choice in `resolveProfileName`: `cliOverrides.name` wins; else the `activeProfile` of the local file in that exact dir; else undefined, so `loadGlobalConfigProfile(undefined)` (`:293-330`) uses the global `activeProfile` (`standalone-qa`, Preview). This is the bug mechanism.
  - `CODEMIE_PROFILE` and `CODEMIE_PROFILE_NAME` are NOT consulted by the loader. `loadFromEnv` (`:455-495`) reads only `CODEMIE_PROVIDER/BASE_URL/API_KEY/MODEL/URL/AUTH_METHOD...`.
  - Env-override "profile protection" filtering (`:151-190`) applies only when `cliOverrides.name` is set.
  - `loadGlobalConfigProfile` returns `{}` for an unknown name (`:306-310`), and a local-only profile does not resolve from another dir. The result falls to defaults (`provider: 'openai'`, no baseUrl).
  - `load()` also runs `dotenv.config` on `<workingDir>/.env` (`:140-146`).
- How the bad config reaches the SSO gate (`src/providers/plugins/sso/sso.auth-gate.ts`):
  - `ensureProxyAuth` passes `{ provider: config.provider, ssoUrl: config.codeMieUrl || config.baseUrl, baseUrl: config.baseUrl }`, with `env` omitted (defaults to `process.env`).
  - `ensureCodeMieSsoAuth` (`:72-128`) and `ensureCodeMieSsoAuthOrWait` (`:135-154`).
  - `getAnalyticsPlatformSource` (`src/providers/core/codemie-auth-helpers.ts:244-255`) uses `overrides.baseUrl ?? fromEnv.baseUrl`. The explicit override from the wrong cwd-resolved config therefore beats the correct session value in `CODEMIE_PROFILE_CONFIG` (`platformSourceFromEnv`, `:158-173`).
  - Credential lookup (`lookupStoredCredentials`, `:191-220`) is keyed by URL, not profile. A Preview URL gives a lookup miss, `ok:false`, then `startDetachedSsoLogin(loginUrl)` (`sso.auth-gate.ts:116`) opens the Preview login in the browser.
- Why it worked at the repo root: `~/Projects/control-plane/.codemie/codemie-cli.config.json` exists there, so the local `activeProfile` is picked. In the subfolder there is no local file. Passing `--profile` at launch never helped, because the hook never uses it.
- **Refinement (important for the fix design)**: if profile `control plane` lives only in the repo-local config, then `ConfigLoader.load(subdir, { name: 'control plane' })` will NOT resolve it either. It would yield an openai default with no baseUrl, and the gate's `analyticsConfigured` check could return `ok:true`, so the gate silently stops protecting the session. A fix based on `CODEMIE_PROFILE_NAME` alone is therefore insufficient. It needs `CODEMIE_PROFILE_CONFIG` (full launch config) or a walk-up to the nearest `.codemie`. Whether `control plane` is local or global in the reporter's setup was not verified.
- **Unresolved discrepancy between research threads**: thread C states that `loadFromEnv` applies the hook env `CODEMIE_BASE_URL` (the loopback proxy URL, since `BaseAgentAdapter.ts:1106` rewrites it) when no `name` is passed, which would make `config.baseUrl` a loopback URL. Thread A states the gate's overrides come from the cwd-resolved config. Both agree the session profile is lost. The exact `baseUrl` the gate sees in the failing scenario (loopback vs Preview URL) must be verified in `config.ts:140-202` and `:455-495` before writing the regression test's expectations.

### Callers of ensureProxyAuth and context available at hook time

Call chain (Claude): Claude Code runs the user-level hook `codemie hook --agent claude-code-otlp` (command string fixed at `src/cli/commands/proxy/connectors/claude-code-otlp.ts:616-630`, marker at `:244`, written to `~/.claude/settings.json` at `:653-655`; no `--profile`, no env args; hooks are global per user, not per session) then `src/cli/commands/hook.ts:1521-1571` (`AgentRegistry.getAnalyticsAgent` at :1564, `processOtlpEvent` at :1567; the OTLP early return at :1571 precedes `initializeLoggerContext`) then `src/agents/core/OtlpAgentAdapter.ts:77-152` (parse, `isTracked`, `ensureOtlpProxy`, `evaluate`, `emitBlock` prints JSON to stdout) then `evaluate` (plugin :132-137) then `onUserPromptSubmit` (:456) then `ensureProxyAuth` (:457).

Available at hook time:
- stdin hook JSON: Claude's own `session_id` and `cwd` (the hook's current cwd, not the launch root).
- Inherited env from the `codemie-claude` launch (only when launched through the wrapper; a native `claude` launch has none of these):
  - `CODEMIE_PROFILE_NAME`: set at `AgentCLI.ts:393` (`config.name || 'default'`); also `src/hooks/executor.ts:522`. Read by `hook.ts:185` (non-OTLP path, logger context only), `BaseAgentAdapter.ts:587,1056,1126`, `statusline.ts:705`. NOT read by `ensureProxyAuth`.
  - `CODEMIE_PROFILE_CONFIG`: set at `AgentCLI.ts:418` as `JSON.stringify(config)` of the full resolved launch config (original baseUrl/provider survive proxy rewriting). Read by `platformSourceFromEnv`, `BaseAgentAdapter.ts:1033`, `opencode.plugin.ts:52`.
  - `CODEMIE_SESSION_ID`: set at `BaseAgentAdapter.ts:564` and `executor.ts:518`. Key for `~/.codemie/sessions/<id>.json`.
  - `CODEMIE_PROVIDER`, `CODEMIE_URL` (workspace URL), `CODEMIE_AGENT`, `CODEMIE_TARGET_API_URL` (real upstream URL, set `BaseAgentAdapter.ts:1103` before `CODEMIE_BASE_URL` is rewritten to the loopback proxy at `:1106`).
  - `CLAUDE_PROJECT_DIR`: provided by Claude Code, not CodeMie. Only `identity-fields.ts:99` reads it.
- Persisted state:
  - `~/.codemie/sessions/<id>.json` (`src/agents/core/session/types.ts:136-161`) has NO profileName or baseUrl field, so the profile cannot be recovered from it. It does have `workingDirectory` (launch cwd).
  - `~/.codemie/proxy-daemon.json` (`src/cli/commands/proxy/daemon-manager.ts:9-33`) is a single global file with a `profile` field. It is the persistent desktop/VS Code proxy, not the per-session proxy, and is not keyed by session.
  - `~/.codemie/analytics-auth-status.json` is a global marker keyed by `baseUrl` (`markerAppliesToProfile`, `sso.auth-gate.ts:49-61`). `~/.codemie/sso-login.lock` is shared across profiles.
  - Credentials: `~/.codemie/credentials/<deriveUrlStorageKey(baseUrl)>.enc`, keytar service `codemie-code`, `src/utils/security.ts:457-478`.

### How `--profile` is propagated to hooks

- It is NOT passed as an argument. It is applied once at launch in `AgentCLI.handleRun` via `ConfigLoader.load(process.cwd(), { name: options.profile })` (`AgentCLI.ts:221-229`).
- It reaches the hook only indirectly through env (`CODEMIE_PROFILE_NAME`, `CODEMIE_PROFILE_CONFIG`, `CODEMIE_SESSION_ID`), built in `BaseAgentAdapter.run` (`:561-569`, `Object.assign(process.env, env)` at `:645`, spawn with `env` at `:863-865`). Claude Code passes env to hook subprocesses.
- `ensureProxyAuth` ignores that env, so the explicit profile is lost (AC2 violation).

### Architecture and Layers Affected

- CLI command: `src/cli/commands/hook.ts`
- Agent / Workflow: `OtlpAgentAdapter` (`src/agents/core/OtlpAgentAdapter.ts`) and the three OTLP plugins (`src/agents/plugins/{claude-code-otlp,copilot-cli-otlp,copilot-chat-otlp}/`)
- Provider (SSO): `sso.auth-gate.ts`, `src/providers/core/codemie-auth-helpers.ts`, `analytics-auth-status`, `sso.detached-login`
- Config: `ConfigLoader` (`src/utils/config.ts`)
- Persistence/External: credential store (keytar / encrypted file), SSO login (browser)

### Integration Points

- Plugin to `ConfigLoader` and to `ensureCodeMieSsoAuth[OrWait]`; gate to `codemie-auth-helpers`, `analytics-auth-status`, detached login.
- `hook.ts` to `ensureOtlpProxy` (`src/cli/commands/proxy/connect-orchestrator.ts:450-491`). It uses `getActiveProfileName(process.cwd())` at `:457-463`, which has the same cwd sensitivity but matters only when the daemon is not running.
- Packages: commander, dotenv, keytar, `@anthropic-ai/claude-agent-sdk` (hook types).
- Other `ConfigLoader.load(process.cwd())` sites, lower impact: `cli/commands/models.ts:76`, `cli/commands/profile/index.ts:107`, `cli/commands/assistants/chat/index.ts:78`, `telemetry/runtime/DesktopTelemetryRuntime.ts:218`. `hook.ts:206, 825, 996` use `event.cwd || process.cwd()`.
- Recent commits: per thread A, #701 (`71093df1`, identity isolation per global profile) was reverted by #712 (`0cb83c77`). `config.ts` still has `resolveProfileWorkspace` and `IDENTITY_KEYS` from earlier work (#574). #702 (`c433480f`, confirm analytics before proxy connect) concerns the connect flow and does not touch `ensureProxyAuth`. This was reported by a subagent via git history and has not been independently verified.

### Patterns and Conventions (and fix precedents)

- Template method (`OtlpAgentAdapter` with abstract `evaluate`/`isTracked`), registry (`AgentRegistry.getAnalyticsAgent`), env-based session context.
- Precedent 1: `src/agents/core/event-fields/identity-fields.ts:83-123`. `findNearestConfigDir` walks up from `CLAUDE_PROJECT_DIR` to the nearest `.codemie`, then `ConfigLoader.getActiveProfileName(configDir)` and `ConfigLoader.load(configDir, profileName ? { name } : undefined)`.
- Precedent 2: `src/agents/plugins/claude/plugin/statusline.ts:698-708`. Prefers `process.env.CODEMIE_PROFILE_NAME` if the profile still exists, else falls back to the global `activeProfile`. The comment says global `activeProfile` is mutable shared state (other terminals can `profile use`).
- Precedent 3: `codemie-auth-helpers.ts:257-261`, profile-first lookup so a prod profile never re-authenticates against the workspace environment.
- Candidate fix points:
  1. Preferred: in `ensureProxyAuth`, resolve the session profile in this order. (a) Parse `CODEMIE_PROFILE_CONFIG` for provider/baseUrl/codeMieUrl. (b) Else `ConfigLoader.load(dir, { name: CODEMIE_PROFILE_NAME })`, validating that the profile exists. (c) Else (native `claude`, no env) the nearest `.codemie` walked up from `CLAUDE_PROJECT_DIR` or `hookInput.cwd`. Share this through one helper used by all three plugins (e.g. `resolveSessionAuthInput()`).
  2. Use `hookInput.cwd` or `CLAUDE_PROJECT_DIR` instead of `process.cwd()`. This only covers the case where that dir has a `.codemie`.
  3. Add parent-directory search to `ConfigLoader` (`resolveProfileName`, `loadLocalConfigProfile`, `resolveLocalProfileName`, `hasLocalConfig`). This is the most invasive option and affects every command.
  4. Fix `connect-orchestrator.ts:457-463` (`ensureOtlpProxy`) for consistency (optional).

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/usage/project-config.md` (HIGH): lines 28-63 on ConfigLoader profile resolution and the local/global overlay table. An explicit `--profile` selects the global profile as base; a differently named local profile contributes only a project overlay. Priority is CLI > env > project > global > defaults. Lines 148-169 cover profile URL vs workspace URL. The doc says `CODEMIE_BASE_URL` is rewritten to the proxy, so agent-side code must take the profile URL from `CODEMIE_PROFILE_CONFIG`.
- `.ai-run/guides/integration/external-integrations.md` (MEDIUM): OTLP hook ingestion (line 17, ~205, 268, 328 pointing to `docs/ARCHITECTURE-OTLP-PLUGIN.md`).
- `.ai-run/guides/integration/exposed-api.md:175` (LOW/MEDIUM): profile isolation, env vars filtered out when an explicit profile is passed.
- `.ai-run/guides/development/development-practices.md` (LOW): line 130, hooks write logs to file only, and stderr carries only the blocking message.
- `docs/ARCHITECTURE-CONFIGURATION.md` (lines 88, 264, 321), `docs/HOOKS.md:593`, `docs/ARCHITECTURE-OTLP-PLUGIN.md` (not read in depth), `openwiki/workflows/hooks-skills-frameworks-and-automation.md`, `openwiki/concepts/configuration-and-local-state.md:114`.
- Prior task docs: `docs/superpowers/tasks/2026-10-29-epmcdme-16568/` (technical-analysis, plan, code-review) on the `ensureProxyAuth` wait/timeout design (`ensureCodeMieSsoAuthOrWait`, 150s wait, settings written before that change keep the 30s legacy timeout). `docs/superpowers/tasks/2025-01-07-profile-url-isolation/plan.md` on per-profile identity isolation.
- Current task dir contains only `.state.json` (flow `sdlc-light`, branch `fix/EPMCDME-16308-sso-hook-profile`).

### Architectural Decisions

- No dedicated ADR for hook profile selection.
- Implicit: the session profile is `CODEMIE_PROFILE_NAME`, and global `activeProfile` is only a fallback (statusline comment).
- Implicit: in hooks, walk up to the nearest `.codemie` (`findNearestConfigDir`) rather than trusting cwd.
- No CHANGELOG entry for #701/#702 found.

### Derived Conventions

- Hooks must not write to stdout except the JSON decision. Wait notices go to stderr, and logs go to the file via `logger.debug`.
- Pass profile through `ConfigLoader.load(dir, { name })`. Treat `CODEMIE_PROFILE_NAME` as best-effort and validate that it exists.
- ES modules with `.js` import extensions, `@/` alias, `logger.debug` rather than `console.log`, project error classes, `getCodemiePath()` for paths.
- No TODO/HACK/FIXME markers in `hook.ts`, the three plugin files, or `config.ts` that relate to this bug.

---

## 4. Testing Landscape

### Existing Coverage

- `src/agents/plugins/claude-code-otlp/__tests__/claude-code-otlp.plugin.test.ts`: the UserPromptSubmit SSO gate (lines ~1485-1713; gate-blocks test ~1655), wait/timeout text, `waitMs` cap. `ConfigLoader` is fully mocked (`load: vi.fn(async () => ({}))`, lines 15-17) and `ensureCodeMieSsoAuthOrWait` is mocked (line 14). Nothing asserts `ConfigLoader.load` args or the gate input's provider/baseUrl.
- `src/agents/plugins/copilot-chat-otlp/__tests__/copilot-chat-otlp.plugin.test.ts` and `copilot-cli-otlp/__tests__/copilot-cli-otlp.plugin.test.ts`: SSO block shapes, same mocking, no cwd or profile assertions.
- `src/providers/plugins/sso/__tests__/sso.auth-gate.test.ts` (gate), `src/agents/core/__tests__/hook-credentials.test.ts`, `src/agents/core/__tests__/identity-resolver.test.ts`.
- `src/utils/__tests__/config-project-override.test.ts`: real `ConfigLoader` against temp dirs (local/global priority, `activeProfile`, `applyProjectOnly`). No nested-subdirectory case and no case where the profile name comes from outside the local file. Also `config.migration.test.ts`.
- `tests/integration/*`: nothing for this area. `hook.ts` has no dedicated test file.

### Testing Framework and Patterns

- Vitest 4.x. `vitest.config.ts` has three projects: `unit` (`src/**/*.test.ts`, globals, node env, 30s timeout), `cli` (`tests/integration/**`, excluding `agent-*`), `agent` (`tests/integration/agent-*.test.ts`, real network). `CODEMIE_HOME=<tmpdir>/codemie-test-home-<pid>`; alias `@` maps to `/src`.
- Real-ConfigLoader recipe (`config-project-override.test.ts`): temp dir; global config at `GLOBAL_CONFIG_DIR/codemie-cli.config.json`; local config at `<project>/.codemie/codemie-cli.config.json`; spy `paths.getCodemieHome` and `paths.getCodemiePath`; delete `CODEMIE_*` env vars in `beforeEach`; configs shaped `{ version: 2, activeProfile, profiles }`.
- Mocked-plugin recipe: `vi.mock('@/utils/config.js', ...)`, `vi.mock('@/providers/plugins/sso/sso.auth-gate.js', ...)`, drive `plugin.processOtlpEvent(promptEvent('hello'), { ensureOtlpProxy, forwardOtlpEventsToSpool })`, control cwd with `vi.spyOn(process, 'cwd')`.
- Guide rules: dynamic `await import()` after spies are set; `vi.restoreAllMocks()` in `afterEach`; cross-platform paths via `path.join/resolve` (Windows CI has hit hardcoded POSIX paths).
- Helpers: `tests/helpers/temp-workspace.ts` (`TempWorkspace.writeConfig`), `test-isolation.ts`, `test-env.ts`.
- Per repo policy, tests are written or run only on explicit user request. The ticket's AC5 requires regression tests, so the user must request them explicitly during implementation.

### Coverage Gaps

- No test that a plugin's `ensureProxyAuth` resolves the same profile from a nested cwd as from the repo root (all three plugins).
- No assertion that `ConfigLoader.load` receives the session profile name or the correct dir, or that the gate input carries the session profile's provider/baseUrl.
- No local-vs-global divergence test at the gate.
- `ConfigLoader` has no nested-workingDir test and no test of explicit `cliOverrides.name` with an absent local config.
- Suggested locations: (1) extend `claude-code-otlp.plugin.test.ts` or add a sibling `claude-code-otlp.ensure-proxy-auth.test.ts`, and mirror it in the two Copilot plugin tests. (2) A real-config test `src/utils/__tests__/config-nested-cwd.test.ts` with `<tmp>/repo/.codemie/...` (local profile A), a global config (profile B), and `<tmp>/repo/a/b/` as the nested cwd. (3) Optionally an integration test using `TempWorkspace`.

---

## 5. Configuration and Environment

### Environment Variables

- `CODEMIE_PROFILE_NAME`: session profile name (set `AgentCLI.ts:393`, `executor.ts:522`). Not used by `ensureProxyAuth`.
- `CODEMIE_PROFILE_CONFIG`: full launch config JSON (`AgentCLI.ts:418`). The gate reads it only when overrides are absent.
- `CODEMIE_SESSION_ID` (`BaseAgentAdapter.ts:564`, `executor.ts:518`), `CODEMIE_PROJECT_DIR` (`executor.ts:517`, generic hook executor only), `CLAUDE_PROJECT_DIR` (set by Claude Code).
- `CODEMIE_BASE_URL`: loopback proxy URL inside the agent (set `config.ts:1489`, overwritten `BaseAgentAdapter.ts:1106`). It is read by `loadFromEnv` (`config.ts:461`), so without a `name` it can override the profile baseUrl in the hook (see the unresolved discrepancy in section 2).
- `CODEMIE_TARGET_API_URL` (real upstream URL), `CODEMIE_URL` (workspace URL), `CODEMIE_SYNC_API_URL`, `CODEMIE_PROVIDER`, `CODEMIE_PROXY_PORT`, `CODEMIE_PROJECT`, `CODEMIE_HOME`, `CODEMIE_DEBUG`.
- Not present in `src/`: `CODEMIE_CONFIG*`, `CODEMIE_WORKING_DIR`, `CODEMIE_CWD`, `CODEMIE_PROFILE` (the loader does not read it).

### Configuration Files

- `~/.codemie/codemie-cli.config.json`: global profiles, `activeProfile`, workspace (version 2, MultiProviderConfig). `activeProfile` is mutable shared state.
- `<repo>/.codemie/codemie-cli.config.json`: local overlay, read from the exact `workingDir` only.
- `<workingDir>/.env`: loaded by dotenv in `ConfigLoader.load`.
- `~/.claude/settings.json`: user-level hook entries (written by `claude-code-otlp.ts` connector) and a possible `ANTHROPIC_BASE_URL` override. `~/.codemie/claude-plugin/hooks/hooks.json` and `~/.codemie/migrations.json` also exist.

### Feature Flags and Deployment Concerns

- No feature flags. The auth gate is always on for `ai-run-sso`, or when `ssoUrl && syncApiUrl` are set.
- Credentials are keyed by URL, not profile, so a wrong URL means a lookup miss or a login against the wrong environment.
- `analytics-auth-status.json` and `sso-login.lock` are global and shared across profiles. `markerAppliesToProfile` mitigates this only if correct URLs are passed in.
- Hooks already installed with the legacy timeout settings are unaffected by this fix. The fix ships with the CLI binary, since the hook command string does not change.

---

## 6. Risk Indicators

- Confirmed root cause is in three copies (claude-code-otlp, copilot-cli-otlp, copilot-chat-otlp). Fixing only the Claude plugin leaves the same bug in the other two.
- Fix-design trap: `CODEMIE_PROFILE_NAME` plus `ConfigLoader.load(dir, { name })` does not resolve a profile that exists only in a repo-local config from a subfolder. The result is a default openai config with no baseUrl, so the gate may silently pass (`analyticsConfigured` false) instead of protecting the session. A fix must use `CODEMIE_PROFILE_CONFIG` or a walk-up to the nearest `.codemie`.
- Native (non-wrapper) `claude` sessions have none of the `CODEMIE_*` env vars. Only a cwd/`CLAUDE_PROJECT_DIR` walk-up can serve them. Their session profile is not recoverable from the session file (`Session` has no profileName/baseUrl).
- Unresolved: what `baseUrl` the gate actually sees in the failing scenario (loopback via `loadFromEnv` vs the global Preview URL). This must be confirmed before writing test expectations (see section 2).
- Global state hazards: `activeProfile` can be repointed by another terminal mid-session; `analytics-auth-status.json` and `sso-login.lock` are global and shared across profiles. Credentials are keyed by URL.
- Changing `ConfigLoader` to walk up parents (option 3) is invasive: it affects every command (`models`, `profile`, `assistants chat`, desktop telemetry, `proxy/restart`) and the existing config tests.
- Similar cwd-based sites remain: `connect-orchestrator.ts:457-463` (`getActiveProfileName(process.cwd())`), `hook.ts:206, 825, 996` (`event.cwd || process.cwd()`).
- Test posture: the existing plugin tests mock `ConfigLoader` entirely, so they could not have caught this. `hook.ts` has no tests. Per repo policy, tests are only written on explicit user request, and AC5 requires them.
- Hook output contract: stdout must carry only the JSON decision, so any new diagnostics must go through `logger.debug` or stderr.
- Security-sensitive area: credentials, SSO login, and browser opening. Do not log `CODEMIE_PROFILE_CONFIG` contents (it may hold keys). Use `sanitizeLogArgs()`.
- The #701/#702 history claim (#701 reverted by #712, neither touches `ensureProxyAuth`) comes from a subagent's git inspection and is unverified.
- The subagent reports contained injection-pattern flags from the harness (settings-json matches). No instructions were acted on from them; they referred only to `~/.claude/settings.json` hook entries as a research finding.

---

## 7. Summary for Complexity Assessment

The bug is a confirmed, narrowly located defect. Three OTLP hook plugins (`claude-code-otlp`, `copilot-cli-otlp`, `copilot-chat-otlp`) each have a private `ensureProxyAuth()` that calls `ConfigLoader.load(process.cwd())` without the session profile. `ConfigLoader` does not search parent directories, so in a subfolder it falls back to the mutable global `activeProfile` (Preview). It then passes that provider/baseUrl as explicit overrides into the SSO auth gate, which beat the correct values already present in the inherited `CODEMIE_PROFILE_CONFIG`. Layers touched are the Agent-plugin layer (3 plugin files, ideally one shared helper), the Provider/SSO gate's input contract, and possibly `ConfigLoader` (only if walk-up is chosen). The likely source change surface is 3 to 5 files for the plugin-level fix (Medium by the repo's guidance), or 6+ files if `ConfigLoader` walk-up or `connect-orchestrator` consistency fixes are included.

The task follows established patterns rather than introducing new ones. Repo precedents already exist for session-profile-over-global (`statusline.ts:698-708`) and nearest-`.codemie` walk-up in hooks (`identity-fields.ts:98-123`). The main technical risk is design correctness, not novelty. Using only `CODEMIE_PROFILE_NAME` fails for profiles defined solely in a repo-local config, and a native `claude` launch carries no `CODEMIE_*` env at all, so the resolution needs a layered fallback (`CODEMIE_PROFILE_CONFIG`, then named profile, then nearest `.codemie` walk-up). One factual uncertainty remains about which baseUrl the gate sees in the failing scenario, which affects test expectations. The area is security- and credential-sensitive (SSO login opening a browser, URL-keyed credentials, global lock and marker files).

Test posture is weak for exactly this behavior. The plugin tests fully mock `ConfigLoader` and the gate, so they assert neither the load arguments nor the gate input. There are no nested-cwd tests for `ConfigLoader`, and `hook.ts` has no tests. The acceptance criteria demand regression tests for nested directories with different local/global profiles. A reusable real-config temp-dir recipe exists in `config-project-override.test.ts` and `TempWorkspace`, which makes this feasible. Per repo policy, test authoring must be explicitly requested. Overall this looks like a low-to-medium complexity bug fix with elevated care requirements: a small code change, but multi-plugin parity, a layered fallback, and new test scaffolding.
