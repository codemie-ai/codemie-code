# Technical Research

**Task**: codemie assistants skills registration cli wizard
**Generated**: 2026-09-18
**Research path**: codegraph

---

## 1. Original Context

implement the command line registration of codemie assistants and skills, so that there are 2 options avaialale - interactive where user can serach for assistants and select via wizard and pure headless command line, where user can specify several assistants and other information as single command. if assistant is not available for user, entire oepration should be stopped with proper error message

---

## 2. Codebase Findings

### Existing Implementations

**Assistants registration (interactive, exists today)**

- `src/cli/commands/assistants/setup/index.ts` — `createAssistantsSetupCommand(hostAgent?: TargetAgent)` (line 37) and `setupAssistants(options, hostAgent)` (line 62). Current flags: `--profile <name>`, `--project <project>`, `--all-projects`, `--agent <agents>`, `-v, --verbose` (`SetupCommandOptions`, line 23). Orchestration order: `ConfigLoader.load` → `getAuthenticatedClient` → `loadRegisteredAssistants` → `promptAssistantSelection` → `promptModeSelection` (/`promptManualConfiguration`) → `promptStorageScope` → `resolveAgentSetupTargets` → `applyChanges` → `ConfigLoader.saveAssistantsToProjectConfig` → `displaySummary`.
- `src/cli/commands/assistants/setup/selection/index.ts` — `promptAssistantSelection(config, options, client)` (line 73). Three-panel raw-TTY selection UI (`Registered` / `Project` / `Marketplace`), `initializeState` pre-checks all already-registered ids, returns `{ selectedIds, action }`.
- `src/cli/commands/assistants/setup/data.ts` — `createDataFetcher({config, client, options})` (line 51): `fetchAssistants` (paginated `client.assistants.listPaginated`), `fetchRegisteredFromConfig`, `fetchAssistantsByIds` (line 147; per-id `client.assistants.get`, wrapped in try/catch that logs `logger.error` and omits the id from the result).
- `src/cli/commands/assistants/setup/helpers.ts` — `registerAssistant(assistant, mode, scope, workingDir, target)` (line 66), `unregisterAssistant` (line 38), `determineChanges` (line 30), `formatInvocationSummary` (line 129). Returns `CodemieAssistant | null`.
- `src/cli/commands/assistants/setup/manualConfiguration/types.ts` — `RegistrationMode = 'agent' | 'skill'` (line 9), `AssistantRegistration`, `ConfigurationState`, `ConfigurationResult`.
- Generators invoked by `registerAssistant`: `setup/generators/claude-agent-generator.ts`, `claude-skill-generator.ts`, `codex-skill-generator.ts`, `gemini-skill-generator.ts`.
- `src/cli/commands/assistants/index.ts` — `createAssistantsCommand()` (line 13) wires **only** `chat`; `setup` is not attached here.

**Skills registration (interactive, exists today)**

- `src/cli/commands/skills/setup/index.ts` — `createSkillsSetupCommand(hostAgent?)` (line 16) and `setupSkills(options, hostAgent)` (line 90). Current flags: `--profile <name>`, `--agent <agents>`, `-v, --verbose`. Flow: `showDisclaimer()` (raw-stdin Enter/Ctrl-C gate, line 39) → `promptStorageScope` → `resolveAgentSetupTargets` → `ConfigLoader.load` → `getAuthenticatedClient` → `ConfigLoader.loadSkillsByScope` → `promptSkillSelection` → `fetchSkillsByIds` → `determineChanges` → register/unregister loops → `ConfigLoader.saveSkillsToProjectConfig`.
- `src/cli/commands/skills/setup/data.ts` — `createSkillDataFetcher({client, registeredSkills})` (line 47): `fetchSkills` (`client.skills.listPaginated`, `PER_PAGE = 5`), `fetchSkillById` (`client.skills.get`), `fetchSkillsByIds` (line 122; fetches `per_page: 100` and filters client-side — comment states "no efficient bulk endpoint").
- `src/cli/commands/skills/setup/helpers.ts` — `registerSkill(skill, scope, workingDir, target)` (line 58), `unregisterSkill` (line 33), `determineChanges` (line 25).
- `src/cli/commands/skills/setup/selection/index.ts` — `promptSkillSelection(registeredSkills, client)` (line 69), same three-panel raw-TTY UI as assistants.

**Existing headless precedents**

- `src/cli/commands/skills/add.ts` — `createAddCommand()` (line 36), a wrapper over the upstream `skills` CLI. Flags `-g/--global`, `-s/--skill <skills...>`, `-a/--agent <agents...>`, `-y/--yes`, `--copy`. Line 52 is the canonical interactivity gate in this repo: `const interactive = !options.yes && process.stdin.isTTY === true;`. Exits with `process.exit(result.code || 1)` on failure.
- `src/cli/commands/skills/lib/agent-detection.ts` — `resolveAgentSelection({cwd, explicitAgents, interactive})` (line 53) with mode taxonomy `'explicit' | 'auto_detected' | 'prompted' | 'upstream'`; defers to upstream instead of prompting when `!interactive`.
- `src/cli/commands/skills/lib/require-auth.ts` — `requireAuthenticatedSession()` (line 24): hard auth gate; on failure prints a canonical red message and `process.exit(1)` via `failAuth` (line 47). Used by `add`, `update`, `remove`, `list`, `find`.
- `src/cli/commands/sdk/assistants.ts` — `createAssistantsSubcommand()` (line 39): fully headless assistant CRUD (`list`, `get <id>`, `create`, `update <id>`, `delete <id>`, `get-tools`) with `--json`, `--scope`, `--page`, `--per-page`, `--search`, `--projects`, `--full-response`, `--data`, backed by `src/cli/commands/sdk/services/assistants.ts`.

### Architecture and Layers Affected

- **CLI command layer (commander)**: `src/cli/commands/assistants/setup/index.ts`, `src/cli/commands/skills/setup/index.ts`, `src/cli/commands/setup.ts` (`createSetupCommand`, lines 27–28 add `createAssistantsSetupCommand().name('assistants')` and `createSkillsSetupCommand().name('skills')`), `src/agents/core/AgentCLI.ts` lines 111–118 (per-agent `codemie-<agent> setup assistants|skills` with `hostAgent = this.adapter.name`), `src/cli/index.ts`.
- **Interactive TTY UI layer**: `setup/selection/{index,actions,ui,interactive-prompt,constants,types,utils}.ts` for both trees; `src/cli/commands/shared/selection/{ui,constants,types}.ts`; `src/cli/commands/shared/prompts/storage-scope.ts`; `src/cli/commands/shared/agent-targets.ts` (`promptAgentTargetSelection`, line 127); `showDisclaimer` in `skills/setup/index.ts`. All of these call `process.stdin.setRawMode(true)`; `inquirer` is used in `agent-detection.ts` and `codemie-auth-helpers.ts`.
- **Data/service layer**: `codemie-sdk` `CodeMieClient` (`client.assistants.*`, `client.skills.*`) via `setup/data.ts` in both trees; `src/cli/commands/shared/api-response-guard.ts`.
- **Generator / filesystem layer**: `assistants/setup/generators/*`, `skills/setup/generators/*` writing agent/skill artifacts under `.claude`, `.codex`, `.gemini`.
- **Config persistence layer**: `src/utils/config.ts` (`ConfigLoader.loadSkillsByScope` line 929, `loadAssistantsByScope` line 955, `saveSkillsToProjectConfig` line 984, `saveAssistantsToProjectConfig`, `getConfigLocationLabel` line 67, `loadConfigByScope`/`saveConfigByScope` lines 73/79); `src/env/types.ts` (`CodemieAssistant` line 24, `CodemieSkill` line 38, `StorageScope` line 8, `MultiProviderConfig` line 176).
- **Auth/provider layer**: `src/utils/auth.ts` `getAuthenticatedClient` (line 22, JWT vs SSO branches), `src/utils/sdk-client.ts` `getCodemieClient`, `src/providers/plugins/sso/sso.auth.ts` `CodeMieSSO`, `src/providers/core/codemie-auth-helpers.ts`.
- **Metrics layer**: `src/cli/commands/skills/lib/skills-metrics.ts` — `startSkillMetric`, `emitStarted/Completed/Failed`, types `SkillCommand = 'add'|'update'|'remove'|'list'|'find'`, `SkillScope`, `AgentSelectionMode`. Wired into the upstream-wrapper commands only, not into `setup skills` / `setup assistants`.
- **Migrations**: `src/migrations/004-skills-assistants-top-level.migration.ts` moved `codemieSkills`/`codemieAssistants` from profile-level to top-level `MultiProviderConfig`.

### Integration Points

- `codemie-sdk`: `CodeMieClient`, `Assistant`, `AssistantBase`, `AssistantListParams`, `AssistantCreateParams`, `AssistantUpdateParams`, `ToolKitDetails`, `SkillListItem`, `SkillDetail`. Endpoints used: `assistants.listPaginated`, `assistants.list`, `assistants.get`, `assistants.getTools`, `skills.listPaginated`, `skills.get`.
- API scope constants: `src/cli/commands/assistants/setup/selection/constants.ts` (`PANEL_ID`, `API_SCOPE.VISIBLE_TO_USER`, `API_SCOPE.MARKETPLACE`, `CONFIG.ITEMS_PER_PAGE`). Skills use inline `'project' | 'marketplace'` with `visibility: 'public'` for marketplace (`skills/setup/data.ts` lines 85–98).
- `AgentRegistry` (`src/agents/registry.ts`) via `detectInstalledTargets()` in `shared/agent-targets.ts` line 108 — calls `adapter.isInstalled()` for `claude`, `codex`, `gemini`.
- Upstream `skills` CLI spawned by `src/cli/commands/skills/lib/run-skills-cli.ts` (`RunSkillsCliOptions` has `interactive?: boolean`, `timeoutMs`, `env`, `cwd`).
- CodeMie metrics endpoint via `skills-metrics.ts` `postOne` (SSO-cookie transport; no-op when `transport === null`).

### Patterns and Conventions

- **Command factories**: every command is `createXCommand(): Command`; setup factories accept `hostAgent?: TargetAgent` and are renamed at the wiring site with `.name('assistants')` / `.name('skills')`.
- **Agent target resolution**: `resolveAgentSetupTargets(value, hostAgent)` (`shared/agent-targets.ts` line 27) — explicit flag wins (`parseAgentSetupTarget`, comma-split, validated against `['claude','codex','gemini']`, throws `ConfigurationError` on unknown value); then `hostAgent`; then `detectInstalledTargets()`; zero detected → `ConfigurationError('No supported agent is installed…')`; one → auto; many → interactive `promptAgentTargetSelection`.
- **Change diffing**: generic `determineChanges<TItem, TRegistered>(selectedIds, allItems, registeredItems)` in `src/cli/commands/shared/helpers.ts` line 39; both trees re-export thin typed wrappers.
- **Spinner wrapper**: `executeWithSpinner(msg, op, successMsg, errorMsg, onError?)` (`shared/helpers.ts` line 6) — swallows the thrown error, invokes `onError`, and returns `null`; spinner text is only rendered when `CODEMIE_DEBUG === 'true'`.
- **Error surface**: `handleSetupError(error, label)` (`shared/helpers.ts` line 64) → `createErrorContext` + `logger.error` + `formatErrorForUser` + `process.exit(1)`. Both setup commands wrap their body in `try/catch → handleSetupError`.
- **Typed errors**: `src/utils/errors.ts` — `CodeMieError` base with `ConfigurationError`, `AgentNotFoundError`, `AgentInstallationError`, `ToolExecutionError`, `PathSecurityError`, `AnalyticsSourceError`, `NpmError`.
- **API shape guard**: `assertApiListResponse(response, isValidShape, context)` (`shared/api-response-guard.ts` line 26) throws `ConfigurationError` with a stale-session ("Run `codemie profile login`") or generic "Unexpected response fetching \<context\>" message. Local type guards `isAssistantListResponse`, `isSkillListResponse`.
- **Registration records**: `CodemieAssistant { id, name, slug, description?, project?, registeredAt, registrationMode?, agentTargets? }`; `CodemieSkill { id, name, slug, description, project?, registeredAt, agentTargets? }`; both persisted at `MultiProviderConfig` top level (`codemieAssistants`, `codemieSkills`).
- **Existence verification on load**: `loadSkillsByScope`/`loadAssistantsByScope` filter records whose `<skillsDir>/<slug>/SKILL.md` is missing; `skillsDir` is `~/.claude/skills` (global) or `<workingDir>/.claude/skills` (local).
- **Re-registration semantics**: the selection UI returns already-registered ids as selected; `applyChanges` (`assistants/setup/index.ts` line 163) computes `toReregister` and unregisters-then-registers them.
- **Behaviour on an item that cannot be fetched**: `fetchAssistantsByIds` logs and omits; `applyChanges` `getFullAssistant` returns `null` and the loop `continue`s (line 190). `registerAssistant`/`registerSkill` return `null` on failure and the caller keeps iterating. No abort, no aggregate error.
- **Repo conventions** (`AGENTS.md`, `.ai-run/guides/standards/code-quality.md`): ES modules, `.js` extensions on all imports, `@/` alias instead of deep relative paths, explicit return types on exports, no `any`, `logger.debug` instead of `console.log`, project error classes instead of generic `Error`.

---

## 3. Documentation Findings

### Guides and Architecture Docs

Guides present under `.ai-run/guides/`: `architecture/architecture.md`, `integration/exposed-api.md`, `integration/external-integrations.md`, `development/development-practices.md`, `standards/code-quality.md`, `standards/git-workflow.md`, `testing/testing-patterns.md`, `security/security-practices.md`, `usage/project-config.md`, `quality-gates.md`, `project.md`.

- `.ai-run/guides/integration/exposed-api.md` — read in full. It documents only the programmatic export surface of `src/index.ts` (`CodeMieSSO`, `CodeMieProxy`, `getPluginRegistry`, `processEvent`, `ConfigLoader`). **It does not cover the `assistants` / `skills` CLI surface at all.** Useful facts it does contribute: `ConfigLoader` priority chain is CLI args → env vars → project config (`.codemie/codemie-cli.config.json`) → global config (`~/.codemie/codemie-cli.config.json`) → defaults; `CodeMieSSO` credentials are stored per base URL and expire after 24 hours; `ConfigLoader.loadAndValidate` throws on missing required fields.
- `.ai-run/guides/testing/testing-patterns.md` — read in full; see section 4.
- No guide documents assistant/skill registration, the selection wizard, or headless CLI conventions.

### Architectural Decisions

- `src/cli/commands/shared/api-response-guard.ts` header comment records the decision to shape-check list responses because a stale SSO session is silently redirected to a Keycloak HTML login page rather than erroring.
- `src/cli/commands/skills/lib/require-auth.ts` header cites "spec §7": every `codemie skills *` subcommand must verify SSO credentials **before any side effect**, and must not emit a metric on auth failure (the metrics transport itself depends on the missing auth context).
- `src/cli/commands/skills/lib/agent-detection.ts` header records the decision to consider only strong project-local markers (`.claude/`, `.cursor/`) and explicitly **not** source domain, registry ownership, or catalog labels — "discovery and trust live in the future CodeMie UI/catalog, not in this CLI".
- `src/cli/commands/skills/lib/skills-metrics.ts` line 112 comment: skills commands emit terminal states only, so an interrupted upstream prompt does not leave durable started-only rows.
- `src/migrations/004-skills-assistants-top-level.migration.ts` records the move of `codemieSkills`/`codemieAssistants` from profile scope to top-level config, de-duplicating by `registeredAt`.
- `src/env/types.ts` line 96 comment: `ProviderProfile.codemieAssistants` is in-memory only; the persisted home is `MultiProviderConfig`.
- `AGENTS.md` policy: tests and git operations only on explicit user request.

### Derived Conventions

- Headless-vs-interactive detection convention in this repo is `!options.yes && process.stdin.isTTY === true` (`skills/add.ts` line 52), paired with an explicit selection-mode label recorded for telemetry.
- Multi-value CLI flags use commander variadic (`-s, --skill <skills...>`) in the skills wrapper and comma-split single-value (`--agent <agents>` + `parseAgentSetupTarget`) in the setup commands. Both styles exist.
- User-facing failure = throw `ConfigurationError` and let `handleSetupError` exit(1); or, for pre-side-effect auth gates, print + `process.exit(1)` directly.
- `MESSAGES` / `ACTIONS` / `ACTION_TYPE` constant objects (`assistants/constants.ts`, `setup/constants.ts`, `manualConfiguration/constants.ts`) hold all user-facing strings for the assistants tree; the skills tree inlines its strings.

---

## 4. Testing Landscape

### Existing Coverage

- `src/cli/commands/assistants/setup/__tests__/helpers.test.ts` — covers `determineChanges` in the assistants tree.
- `src/cli/commands/assistants/setup/__tests__/data.test.ts` — covers `SetupCommandOptions`-driven data fetching.
- `src/cli/commands/assistants/setup/__tests__/index.test.ts` and `src/cli/commands/assistants/__tests__/setup.test.ts` — cover `createAssistantsSetupCommand`.
- `src/cli/commands/assistants/__tests__/index.test.ts` — covers `createAssistantsCommand`.
- `src/cli/commands/assistants/setup/selection/__tests__/` — `index.test.ts`, `actions.test.ts`, `interactive-prompt.test.ts`, `ui.test.ts`, `utils.test.ts`.
- `src/cli/commands/assistants/setup/manualConfiguration/__tests__/types.test.ts` — covers `RegistrationMode` / `AssistantRegistration`.
- `src/cli/commands/skills/setup/__tests__/data.test.ts`, `src/cli/commands/skills/setup/selection/__tests__/ui.test.ts`.
- `src/cli/commands/skills/lib/__tests__/agent-detection.test.ts` — covers `resolveAgentSelection` including the non-interactive fallthrough.
- `src/cli/commands/shared/__tests__/api-response-guard.test.ts` — covers `assertApiListResponse`.
- `src/utils/__tests__/auth.test.ts` — covers `getAuthenticatedClient`.
- `src/utils/__tests__/config.migration.test.ts`, `src/utils/__tests__/config-project-override.test.ts`, `src/migrations/__tests__/migrations-001-004.migration.test.ts` — cover the skills/assistants config migration and project override.
- `tests/integration/agent-assistant.test.ts` — integration coverage touching `listAssistants`.

### Testing Framework and Patterns

- Vitest, projects `unit | cli | agent` (`npx vitest run --project unit`); unit tests co-located at `src/**/__tests__/*.test.ts`, integration at `tests/integration/*.test.ts`; config `vitest.config.ts`.
- Mandatory pattern from `.ai-run/guides/testing/testing-patterns.md`: dynamic `await import()` of the module under test **inside** the test body/`beforeEach`, after spies are installed — static imports are cached before `beforeEach` and bypass spies.
- `vi.mock()` for whole-module fakes; `vi.spyOn()` in `beforeEach` + `vi.restoreAllMocks()` in `afterEach`.
- Lazy-getter override pattern for class-level statics (documented against `src/utils/config.ts:47-60` `ConfigLoader.GLOBAL_CONFIG`).
- Cross-platform rule: never hardcode POSIX paths or `file://` literals; derive via `path.join()` / `pathToFileURL()`.
- Async error assertions: `await expect(fn()).rejects.toThrow(ErrorClass)`, plus class **and** error-code assertions.
- Coverage targets in the guide: 80% overall, 90%+ for `src/utils/` and core logic, 60% acceptable for UI.
- Repo memory note (`lint-staged-runs-staged-agent-tests`): committing an `agent-*.test.ts` file trips a live PTY test in the pre-commit hook.

### Coverage Gaps

Symbols codegraph reports with **no covering tests** in the touched area:

- `setupAssistants` (`src/cli/commands/assistants/setup/index.ts:62`) — the orchestration function itself.
- `setupSkills` (`src/cli/commands/skills/setup/index.ts:90`) and `createSkillsSetupCommand` (line 16).
- `src/cli/commands/skills/setup/helpers.ts` — `determineChanges`, `registerSkill`, `unregisterSkill`, `RegistrationChanges`.
- `src/cli/commands/assistants/setup/helpers.ts` — `RegistrationChanges`.
- `src/cli/commands/shared/agent-targets.ts` — `resolveAgentSetupTargets`, `parseAgentSetupTarget`, `detectInstalledTargets`, `promptAgentTargetSelection`.
- `src/cli/commands/shared/prompts/storage-scope.ts` — `promptStorageScope`.
- `src/cli/commands/shared/helpers.ts` — `handleSetupError`.
- `src/cli/commands/skills/lib/require-auth.ts` — `requireAuthenticatedSession`.
- `src/cli/commands/skills/setup/data.ts` — `SkillDataFetcher` / `createSkillDataFetcher` interface surface.
- `src/cli/commands/skills/add.ts` — `createAddCommand`.
- `src/cli/commands/skills/lib/skills-metrics.ts` — `SkillCommand`, `SkillScope`, `startSkillMetric`, `emit*`.
- `src/cli/commands/skills/lib/run-skills-cli.ts` — `RunSkillsCliOptions` / `runSkillsCli`.
- `src/cli/commands/setup.ts` — `createSetupCommand`.
- `src/env/types.ts` — `StorageScope`.
- `src/providers/core/codemie-auth-helpers.ts` — `fetchCodeMieUserInfo`, `selectCodeMieProject`, `authenticateWithCodeMie`.

---

## 5. Configuration and Environment

### Environment Variables

Observed in or adjacent to the feature area:

- `CODEMIE_DEBUG` — set to `'true'` by `enableVerboseLogging()` (`shared/helpers.ts:56`); also gates whether `executeWithSpinner` renders spinner success/fail text (line 13) and is set by `setup.ts` `--verbose` (line 32).
- `CODEMIE_SESSION_ID` — seeds the skills metric session id (`skills-metrics.ts:92`), else `randomUUID()`.
- `CODEMIE_CLI_VERSION` — sent as `User-Agent`/`X-CodeMie-CLI` headers (`codemie-auth-helpers.ts:31`, `metrics-api-client.ts:60`).
- `CODEMIE_JWT_TOKEN`, `CODEMIE_AUTH_METHOD` — JWT auth path (`AgentCLI.ts:207-208`, `sso.proxy.ts:73`).
- `CODEMIE_INSECURE` — `verify_ssl: process.env.CODEMIE_INSECURE !== '1'` in `getAuthenticatedClient` (`src/utils/auth.ts:39`).
- `CODEMIE_SKILLS_SEARCH_URL` — overrides `workspace.skillsSearchUrl` for `codemie skills find` (`src/env/types.ts:125-129`).
- `CODEMIE_PROFILE_CONFIG`, `CODEMIE_PROFILE_NAME`, `CODEMIE_MODEL_SOURCE`, `CODEMIE_STATUS`, `CODEMIE_SESSION_ANALYTICS_REPORT` — set by `AgentCLI.handleRun` for spawned agents.
- `GIT_TERMINAL_PROMPT='0'`, `GCM_INTERACTIVE='never'` — injected by `skills add` when spawning the upstream CLI (`add.ts:88-89`).
- `process.stdin.isTTY` — the de-facto interactivity signal (`add.ts:52`; also checked before `setRawMode` in `agent-targets.ts:177,207`).

### Configuration Files

- `~/.codemie/codemie-cli.config.json` — global config (`ConfigLoader.GLOBAL_CONFIG`, resolved via `getCodemiePath`).
- `<workingDir>/.codemie/codemie-cli.config.json` — local/project config (`ConfigLoader.LOCAL_CONFIG`, `src/utils/config.ts:62`).
- `MultiProviderConfig` (v2) shape (`src/env/types.ts:176`): `{ version: 2, activeProfile, codemieSkills?, codemieAssistants?, userEmail?, workspace?, profiles }`.
- `WorkspaceConfig` fields relevant here: `codeMieUrl`, `codeMieProject`, `codeMieIntegration`, `assistants.maxHistoryMessages`, `skillsSearchUrl`.
- `StorageScope` enum: `GLOBAL = 'global'`, `LOCAL = 'local'`; label rendering via `ConfigLoader.getConfigLocationLabel`.
- Generated artifact locations verified on load: `~/.claude/skills/<slug>/SKILL.md` (global) or `<workingDir>/.claude/skills/<slug>/SKILL.md` (local) — `config.ts:939-941`. Codex and Gemini artifacts are written by their own generators.
- `.codemie/codemie-cli.config.json` in-repo is referenced by `AGENTS.md` for tracker lookups.
- `src/env/manager.ts` — `EnvManager` reads/writes `~/.codemie/codemie-cli.config.json` as a flat key/value store with `process.env` taking priority (`getConfigValue`, line 37).

### Feature Flags and Deployment Concerns

- No feature flag gates assistants/skills registration. The only runtime toggles are `--verbose`/`CODEMIE_DEBUG` and `CODEMIE_INSECURE`.
- Setup subcommands are exposed at two wiring sites that must stay in sync: `src/cli/commands/setup.ts:27-28` (`codemie setup assistants` / `codemie setup skills`) and `src/agents/core/AgentCLI.ts:115-116` (`codemie-<agent> setup assistants|skills`, gated by `isSetupCapableAgent`, passing `hostAgent = this.adapter.name`).
- Quality gates before merge (`AGENTS.md`, `.ai-run/guides/quality-gates.md`): `npm run lint` (zero-warning), `typecheck`, `build`, `test`, license and secret scans; `.husky/pre-commit` runs `check:pre-commit`; Conventional Commits enforced by `commitlint.config.cjs`.
- Secrets: SSO cookies are stored encrypted (`ssoConfig.cookiesEncrypted`) and expire after 24h; `sanitizeLogArgs()` is the required path for any log line that could carry a token.

---

## 6. Risk Indicators

- **The stated fail-fast requirement contradicts current behaviour.** `src/cli/commands/assistants/setup/data.ts:168-176` catches a per-id `client.assistants.get` failure, calls `logger.error`, and omits that assistant; `applyChanges` then hits `getFullAssistant → null` and `continue`s (`setup/index.ts:190`). `skills/setup/data.ts:122-136` filters requested ids out of a `per_page: 100` page with no not-found signal. An id the user cannot access today produces a partial success, not an abort.
- **`executeWithSpinner` structurally swallows registration failures** (`shared/helpers.ts:6-37`): it returns `null`, and both `registerAssistant` and `registerSkill` translate that into "skip this item" while the surrounding loop continues. Any all-or-nothing semantics has to contend with this helper.
- **No non-TTY path exists in either setup command.** `showDisclaimer` (`skills/setup/index.ts:67`) calls `process.stdin.setRawMode(true)` unguarded; `promptStorageScope`, `promptAgentTargetSelection`, `promptSkillSelection`, `promptAssistantSelection`, `promptModeSelection`, `promptManualConfiguration` are all unconditional in the current flow. `resolveAgentSetupTargets` only skips its prompt when `--agent` is supplied or exactly one agent is detected.
- **Two independent "skills" surfaces already coexist and mean different things**: `codemie skills add|update|remove|list|find` (wrapper over the upstream skills.sh CLI, `src/cli/commands/skills/*.ts`) versus `codemie setup skills` (CodeMie platform skill registration, `src/cli/commands/skills/setup/`). Naming any new headless entry point risks colliding with or being confused for the wrapper.
- **Dual flag conventions**: variadic (`-s, --skill <skills...>` in `add.ts`) versus comma-split single value (`--agent <agents>` + `parseAgentSetupTarget`). Inconsistent parsing is a live source of user confusion.
- **Auth gating is asymmetric**: `skills add/list/remove/update/find` call `requireAuthenticatedSession()` before any side effect; `setup assistants` / `setup skills` rely on `getAuthenticatedClient` failing later, and `setup skills` runs `showDisclaimer` + two prompts *before* it authenticates at all (`skills/setup/index.ts:94-107`).
- **`setupAssistants` "back" path drops `hostAgent`**: `return setupAssistants(options)` at `setup/index.ts:95` omits the second argument, so a back-navigation loses the host-agent binding.
- **`loadSkillsByScope` / `loadAssistantsByScope` verify existence only under `.claude/skills`** (`config.ts:939-941`) even when `agentTargets` is `codex` or `gemini` — records for non-Claude targets can be filtered out of "registered".
- **`registerSkill` success message uses `sanitizeToSlug(skill.name)`** (`skills/setup/helpers.ts:80`) while the persisted record stores the generator-returned `result` slug — the printed invocation can disagree with the stored slug.
- **Test blind spots on exactly the orchestration that would change**: `setupAssistants`, `setupSkills`, `resolveAgentSetupTargets`, `parseAgentSetupTarget`, `promptStorageScope`, `handleSetupError`, `requireAuthenticatedSession`, `createSetupCommand` all report no covering tests.
- **No documentation exists for this domain.** `.ai-run/guides/integration/exposed-api.md` covers only the `src/index.ts` programmatic exports; no guide describes the assistants/skills CLI, the selection wizard, or headless conventions. Conventions in section 2 were derived from code.
- **Stale-session failure mode is silent at the transport level**: a redirected SSO session returns Keycloak HTML with a 2xx; only `assertApiListResponse` catches it, and it is wired into `listPaginated` paths only — `client.assistants.get` and `client.skills.get` are not shape-guarded.
- `Speculative:` a headless mode is likely to need an explicit non-interactive branch in `setupAssistants`/`setupSkills` that bypasses `showDisclaimer`, `promptStorageScope` and the selection UI, plus a resolver from user-supplied assistant/skill identifiers to ids; the identifier form (id vs slug vs name) is not determined by anything in the current code and is a spec decision.
- `Speculative:` all-or-nothing semantics would likely require a pre-flight availability check before the first filesystem write, since registration today is per-item and incremental with no rollback; whether partial writes must be rolled back is a spec decision.
- `Speculative:` if the new surface should emit telemetry consistent with `skills add`, `SkillCommand` in `skills-metrics.ts:44` currently enumerates only `'add'|'update'|'remove'|'list'|'find'` — but whether the feature emits metrics at all is undecided.

---

## 7. Summary for Complexity Assessment

The feature area is already substantially built out as an **interactive-only** flow across two parallel command trees. `src/cli/commands/assistants/setup/` (≈12 files: `index.ts`, `data.ts`, `helpers.ts`, `constants.ts`, four generators, `selection/` with six files, `configuration/`, `manualConfiguration/`, `summary/`) and `src/cli/commands/skills/setup/` (a near-mirror, minus the mode-selection step) both funnel through the same shared layer: `src/cli/commands/shared/{helpers.ts, agent-targets.ts, api-response-guard.ts, prompts/storage-scope.ts, selection/*}`, then persist through `ConfigLoader` into the top-level `codemieAssistants` / `codemieSkills` arrays of `MultiProviderConfig`. Command wiring is duplicated at two sites (`src/cli/commands/setup.ts:27-28` and `src/agents/core/AgentCLI.ts:115-116`). The layers a change here touches are therefore: commander command layer, TTY interaction layer, codemie-sdk data layer, filesystem generator layer, config persistence layer, and the SSO/JWT auth layer — six, with the metrics layer adjacent but currently unwired for `setup`.

Technical novelty is low-to-moderate: nothing in the task requires a new architectural pattern, because both halves already have precedent in-repo. Headless interactivity gating, variadic multi-value flags, explicit-vs-detected selection modes, pre-side-effect auth gating, and hard `process.exit(1)` failure all exist in `src/cli/commands/skills/add.ts` and `skills/lib/{require-auth,agent-detection}.ts`; the fully headless assistant CRUD surface exists in `src/cli/commands/sdk/assistants.ts`. The genuinely novel part is behavioural rather than structural: the current registration pipeline is deliberately *partial-tolerant* — `fetchAssistantsByIds` omits unfetchable ids, `getFullAssistant` returns `null` and the loop continues, and `executeWithSpinner` converts any thrown error into a `null` return with no propagation. A fail-fast, all-or-nothing contract cuts against three separate existing helpers, and the interactive path's prompt sequence (`showDisclaimer` → `promptStorageScope` → `resolveAgentSetupTargets` → selection UI → mode selection) calls `process.stdin.setRawMode(true)` unconditionally in several places, so a non-TTY branch has no existing seam.

Test coverage posture is uneven and unfavourable exactly where the work lands. The selection UI, `determineChanges`, `api-response-guard`, `agent-detection`, and the config migration are all covered; but codegraph reports **no covering tests** for `setupAssistants`, `setupSkills`, `createSkillsSetupCommand`, `createSetupCommand`, the whole of `skills/setup/helpers.ts`, `resolveAgentSetupTargets`/`parseAgentSetupTarget`, `promptStorageScope`, `handleSetupError`, and `requireAuthenticatedSession` — i.e. the orchestration and resolution functions, not the pure helpers. Combined with zero documentation for this domain (no guide covers the assistants/skills CLI; `exposed-api.md` documents only `src/index.ts` exports), the key risk factors are: the partial-success-vs-fail-fast conflict, the absence of any non-TTY seam, the duplicated command wiring, the coexistence of two different `skills` surfaces with different semantics, and orchestration-level test blind spots that make behavioural regressions hard to catch.

---

## 8. External References

None named by the task. `task_context` is a prose requirement statement with no file path, URL, ticket id, or spec reference. `run_dir` contains only `state.local.json` (task-runner state, not a source of truth).
