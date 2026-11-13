# Technical Research

**Task**: analytics, claude-code-otlp, proxy, disable (EPMCDME-16396)
**Generated**: 2026-10-28
**Research path**: filesystem (codegraph MCP tool not available in this session)

---

## 1. Original Context

EPMCDME-16396 — [CodeMie CLI][Analytics] Allow users to disable analytics globally or for specific projects.

Description: Provide CLI commands to manage analytics collection after CodeMie analytics has been configured, including when Global scope has already been enabled. Users must be able to stop analytics collection without removing or reinstalling the CodeMie integration.

NOTE ON SCOPE: disabling analytics for personal subscriptions (a former AC2) was split out to EPMCDME-16479 and is explicitly OUT OF SCOPE for this ticket. Do not research or plan personal-subscription/account-classification work.

Acceptance Criteria (current scope only):

AC1 — Disable all analytics
- Provide a CLI command to stop all analytics collection.
- No Claude Code sessions should send analytics to the CodeMie backend while collection is disabled.
- CodeMie SSO must not be triggered solely for analytics collection.

AC2 — Disable analytics for a specific project
- Provide a CLI command to disable analytics for a selected project.
- Analytics for other enabled projects must continue working.
- The exclusion must also be respected when Global scope is enabled.

AC3 — Persist and display configuration
- Changes must be saved and applied to subsequent Claude Code sessions.
- Provide a way to view the effective analytics scope, enabled projects, and exclusions.
- Disabled sessions must not trigger analytics forwarding through previously installed global hooks.

AC4 — Regression coverage
- Verify both disable operations (all analytics and a specific project) under Project and Global scopes, including native Claude Code launches. Verify that disabling one project does not affect other projects and that disabling all analytics stops collection entirely.

Out of scope: listing/disabling several configurations at once; personal subscriptions (EPMCDME-16479).

Prior investigation docs exist in `docs/superpowers/specs/` and `docs/superpowers/work-items/` for this ticket — this analysis independently re-verified their factual claims against current `origin/main` (branch `EPMCDME-16396_analytics-disable`) rather than trusting them. See Section 3 for cross-check results; they were found to be largely accurate (not stale) on the facts that matter, with the personal-subscription portions correctly already excluded.

---

## 2. Codebase Findings

### Existing Implementations

- `src/agents/core/OtlpAgentAdapter.ts` — base class/contract for every OTLP hook adapter. Owns the fixed flow: parse hook input → `isTracked` gate → daemon start (`ensureOtlpProxy`) → `evaluate()` → enrich → spool forward. Contains an explicit code comment labelled **INVARIANT** (lines ~69-80): an untracked project must produce no spool data, must not start the daemon, and must not trigger SSO.
- `src/agents/plugins/claude-code-otlp/claude-code-otlp.plugin.ts` — `ClaudeCodeOtlpPlugin extends OtlpAgentAdapter`. Implements `isTracked()` (lines 91-93), delegating to `isProjectTracked(hookInput.cwd, await readAllowlistState())`. Implements `onUserPromptSubmit`, which is the **only** path that calls `ensureProxyAuth()` → `ensureCodeMieSsoAuth` (SSO). SSO is reached only from inside `evaluate()`, which itself only runs after `isTracked()` passes.
- `src/agents/plugins/claude-code-otlp/claude-code-otlp.allowlist.ts` — Claude-specific allowlist storage: reads/parses `~/.claude/settings.json` → `env.CODEMIE_ANALYTICS_PROJECT_FILTER` (a JSON-stringified array of absolute project paths, stored as a string value inside Claude's own settings file). Defines `AllowlistScope = 'user' | 'project'` and `inferAllowlistScope()`. Doc comment explicitly states "the daemon has no allowlist logic."
- `src/agents/core/project-allowlist.ts` — agent-independent, reusable path/allowlist primitives: `AllowlistState` (`{kind:'absent'} | {kind:'valid', paths} | {kind:'invalid'}`), `parseAllowlist`, `canonicalizePath` (symlink-aware via `realpath`, Windows case-insensitive), `isPathInside`, `isProjectTracked(cwd, state)` (absent/empty ⇒ tracked-all; invalid ⇒ fail-closed/not-tracked; otherwise cwd must be nested under a listed path), `addProjectPath`/`removeProjectPath`. **This is an inclusion-only allowlist — no exclusion/deny concept exists.**
- `src/agents/core/copilot-connector-scope.ts` — Copilot's richer per-connector scope model: `CopilotConnectorScope = {enabled:false} | {enabled:true, scope:'user'} | {enabled:true, scope:'project', paths:string[]}`. Persistence via `getCodemiePath('<file>.json')`, atomic temp-file+rename writes, tri-state read result (`{kind:'ok', value}` / `{kind:'corrupt'}`, never throws), fail-closed on corruption, merge-write preserves other keys. This is the strongest existing template for a new CodeMie-owned "analytics preferences" config file — but it still lacks an *exclusion* list within an enabled/user(global) scope, so it does not itself close the AC2 gap.
- `src/providers/plugins/sso/proxy/plugins/otlp.plugin.ts` — proxy daemon-side OTLP ingest interceptor (spool tick/sweep, credential refresh). Has **zero allowlist/scope awareness**; purely transports whatever the hook already decided to forward.
- `src/cli/commands/proxy/index.ts` — commander wiring for `proxy start/stop/status/connect/disconnect/inspect`. `connect`/`disconnect` both accept `--claude-code-otlp`, `--copilot-chat-otlp`, `--copilot-cli-otlp`, and `--scope <user|project>`. Uses `.enablePositionalOptions()`, `addOption(new Option(...).default(...).choices([...]))`, alias-option merging, and a `--json` flag on `status`.
- `src/cli/commands/proxy/connect-orchestrator.ts` / `disconnect-orchestrator.ts` — `connectTargets()` / `disconnectTargets()`; compose per-connector writers. `disconnect --scope project` removes only the current project from the allowlist (falls back to full removal if it was the last entry); `--scope user` removes all CodeMie wiring entirely (hooks + env + filter + backup restore).
- `src/cli/commands/proxy/connectors/claude-code-otlp.ts` — `writeClaudeCodeOtlpConfig`/`removeClaudeCodeOtlpConfig`: writes/merges hook entries + OTEL env vars + allowlist into `~/.claude/settings.json`; atomic writes, `.codemie-backup` backup/restore, ownership-by-value detection (`isCodemieOwnedEnvValue`). **No "disabled" state exists today — only full removal (disconnect) or allowlist narrowing by the current cwd's project.** There is no parameter to disable an arbitrary (non-cwd) project.
- `src/cli/commands/proxy/claude-code-otlp-flow.ts` and `src/cli/commands/proxy/prompts/analytics-confirmation.ts` — confirmation-prompt flow and inquirer-based Confirm/Decline UX added in PR #702; reusable pattern for any new disable confirmation prompt.
- `src/cli/commands/analytics/index.ts` (+ `aggregator.ts`, `formatter.ts`, `data-loader.ts`, `native-loader.ts`, `otel-loader.ts`, `types.ts`) — **pre-existing `codemie analytics` command**, but this is a local reporting/metrics display command, not a collection-control command. Naming for the new disable subcommand group must avoid collision/confusion with this existing namespace.
- `src/agents/plugins/copilot-chat-otlp/`, `copilot-cli-otlp/` — sibling OTLP adapters using `isCopilotProjectTracked`/`copilot-connector-scope.ts` instead of Claude's allowlist; useful cross-reference but personal-subscription/Copilot scope work is out of scope for this ticket (EPMCDME-16479) — reference only, do not extend.

### Architecture and Layers Affected

- **Hook/adapter layer**: `src/agents/plugins/claude-code-otlp/*`, `src/agents/core/OtlpAgentAdapter.ts`, `src/agents/core/project-allowlist.ts` — runs per-hook-invocation in a short-lived child process spawned by Claude Code itself.
- **Config/storage layer**: `~/.claude/settings.json` (Claude-owned, shared with the user's own settings) vs. CodeMie-owned JSON files under `getCodemiePath(...)` (pattern: `copilot-connector-scope.ts`'s file).
- **CLI command layer**: `src/cli/commands/proxy/*` (commander-based: connect/disconnect/status/inspect) and the separate, unrelated `src/cli/commands/analytics/*` (reporting-only).
- **Proxy daemon layer**: `src/providers/plugins/sso/proxy/plugins/otlp.plugin.ts` + `otlp-spool/*` — long-lived daemon process; pure transport, no allowlist/scope awareness.
- **SSO/auth layer**: `src/providers/plugins/sso/sso.auth-gate.js` (`ensureCodeMieSsoAuth`) — invoked only from within `evaluate()` on `UserPromptSubmit`, i.e. strictly after the `isTracked` gate.

### Integration Points

- `claude-code-otlp.plugin.ts` → `OtlpAgentAdapter.ts` (extends; must not touch base-class flow/ordering).
- `claude-code-otlp.plugin.ts` → `claude-code-otlp.allowlist.ts` (the `isTracked` gate's data source).
- `claude-code-otlp.plugin.ts` → `sso.auth-gate.js` (SSO call site, reached only post-gate, only from `onUserPromptSubmit`).
- `claude-code-otlp.allowlist.ts` → `project-allowlist.ts` (shared path primitives — `canonicalizePath`, `isPathInside`, `isProjectTracked`).
- `connectors/claude-code-otlp.ts` → `claude-code-otlp.allowlist.ts` (CLI reads/writes the same allowlist the hook reads at runtime).
- `connect-orchestrator.ts` / `disconnect-orchestrator.ts` → `connectors/claude-code-otlp.ts`.
- `otlp.plugin.ts` (daemon) → `otlp-spool/*` only — confirmed no dependency back into the allowlist/isTracked layer (daemon has zero scope awareness; filtering is hook-side only).

### Patterns and Conventions

- **CodeMie-owned config persistence pattern** (`copilot-connector-scope.ts`): path via `getCodemiePath('<file>.json')`; versioned JSON (`{version, connectors: Record<id, scope>}`); atomic write via temp-file + rename; read helpers return a tri-state result and never throw; fail-closed semantics (corrupt/absent ⇒ disabled/not-tracked); merge-write preserves unrelated keys. **Strong template for a new per-user analytics-preferences file** rather than further overloading `~/.claude/settings.json`'s `env` string value (which Claude Code itself also reads/writes, and whose `connect --scope user` path resets the allowlist to `[]`).
- **Inclusion-only allowlist pattern** (both Claude's `project-allowlist.ts` and Copilot's `copilot-connector-scope.ts`): no path in the codebase today supports "track all except X." This is the concrete, confirmed gap for AC2 ("exclusion must be respected even when Global scope is enabled").
- **isTracked-before-everything invariant**: enforced centrally in `OtlpAgentAdapter.processOtlpEvent`, explicitly commented as an INVARIANT. Any new disable mechanism should plug into `isTracked()` (or the state it reads), not add a second gate elsewhere — this preserves the "no daemon start, no SSO, no spool write" guarantee for AC1/AC3 with zero changes to ordering.
- **No "disabled" state distinct from connect/disconnect today**: `disconnect` either fully strips hook wiring (teardown) or narrows the inclusion allowlist by exactly one project (the cwd's). Neither "pauses" collection while preserving hook/OTel wiring, which AC1/AC3 require ("without removing or reinstalling the integration"). This implies new persisted state is needed (e.g. an `enabled`/`disabled` flag plus an exclusion list), most naturally as a new CodeMie-owned config file following the `copilot-connector-scope.ts` pattern, read by `isTracked()`.
- CLI conventions: commander `Command` composition with `.enablePositionalOptions()`, `Option(...).choices([...])`, orchestrator functions separated from command wiring, `--json` output mode precedent on `status`.
- Atomic file writes + backup/restore with ownership-by-value detection, used throughout `connectors/claude-code-otlp.ts` — relevant if a new disable command needs to safely mutate `~/.claude/settings.json` again, or safely co-exist with it.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — confirms `OtlpAgentAdapter` as a registered non-chat plugin type, one plugin per coding tool; points to `docs/ARCHITECTURE-OTLP-PLUGIN.md` as canonical. No disable/scope guidance of its own.
- `.ai-run/guides/integration/external-integrations.md` — documents the OTLP hook-event ingestion pipeline (native hook → `codemie hook --agent <adapter-name>` → proxy daemon spool → analytics API); `claude-code-otlp` is the reference implementation. No disable/scope guidance.
- `.ai-run/guides/integration/exposed-api.md` — documents public surface (`processEvent`/`CodeMieProxy`/`ConfigLoader`); background only.
- `docs/ARCHITECTURE-OTLP-PLUGIN.md` §3.5/§1 — confirms `isTracked(input)` as an abstract allowlist gate invoked before `ensureOtlpProxy()`, an invariant a subclass cannot skip.
- `docs/ARCHITECTURE-PROXY.md` §6.14 "Claude Code OTLP Per-Project Allowlist" — documents the already-shipped `CODEMIE_ANALYTICS_PROJECT_FILTER` mechanism in full (empty/absent = track everything; cwd nested under an entry = tracked; invalid = fail-closed/track-nothing). States "filtering is hook-side only" and that untracked projects get no daemon start, no SSO check, no spool forward. §6.12 documents a separate, architecturally independent "SSO Session Sync Plugin" / `CODEMIE_SESSION_SYNC_ENABLED` channel for managed-session (`codemie claude`) metrics/conversation sync — a genuinely open scope question for this ticket (see Section 6).

### Architectural Decisions

- `isTracked` is the designated single choke point for any disable rule — corroborated independently by both the architecture docs and the prior investigation docs.
- PR #702 (`c433480f`, merged to `main`) added `AllowlistScope`/`inferAllowlistScope`, the confirmation-prompt flow, and `--silent`; its own AC6 explicitly deferred a "status command" as follow-up work — this ticket's AC3 picks that up.
- No ADR records a disable-scope design beyond the two uncommitted investigation docs already in this run directory's lineage (`docs/superpowers/specs/...` and `docs/superpowers/work-items/EPMCDME-16396.md`) — those are the de facto design-decision record pending formalization, not yet reflected in `docs/ARCHITECTURE-*.md`.
- Convention: never modify `OtlpAgentAdapter`/core files when adding tool-specific behavior — new logic belongs in `claude-code-otlp.plugin.ts`'s `isTracked()` or the allowlist/config file it reads.

### Derived Conventions

- Reuse `canonicalizePath`/`isPathInside` from `project-allowlist.ts` for any new exclusion-path matching (already handles symlinks and Windows case-insensitivity) rather than reimplementing.
- Follow the `copilot-connector-scope.ts` persistence shape (`getCodemiePath`, versioned JSON, atomic write, tri-state fail-closed read) for a new analytics-preferences file.
- A code-level claim flagged by the investigation docs but not yet independently verified in this run: whether `getClaudeSettingsPath()` in `claude-code-otlp.allowlist.ts` honors a `CLAUDE_CONFIG_DIR` override or hardcodes `~/.claude`. No architecture doc corroborates or contradicts this — treat as unverified and check directly during planning.
- Every specific proposed function/file name in the work-item doc's "Proposed approach" section (e.g. `claude-analytics.json`, `codemie proxy analytics` subcommand, `evaluateClaudeAnalyticsGate`) is a **proposal only**, not yet-implemented/verified code — none of these exist in current `origin/main`.

---

## 4. Testing Landscape

### Existing Coverage

- `src/agents/plugins/claude-code-otlp/__tests__/claude-code-otlp.allowlist.test.ts` — unit tests for `parseAllowlist`, `inferAllowlistScope`, `isPathInside`, `isProjectTracked`, `addProjectPath`/`removeProjectPath` (re-exported from `project-allowlist.js`). Covers absent/empty/valid/invalid states and scope inference only for the current inclusion-only model.
- `src/agents/plugins/claude-code-otlp/__tests__/claude-code-otlp.plugin.test.ts` — large suite for `processOtlpEvent`; mocks `isProjectTracked` directly to assert "does nothing for untracked projects, for every event" vs. "ensures proxy then forwards for tracked projects." Does not exercise allowlist-writing logic itself.
- `src/agents/core/__tests__/copilot-connector-scope.test.ts` — sibling template (out-of-scope feature area, but directly relevant as a pattern) testing the explicit `{enabled, scope, paths}` model with fail-closed corrupt-read handling and real temp-file I/O.
- `src/cli/commands/proxy/connectors/__tests__/claude-code-otlp.test.ts` — the most relevant existing test file. Exhaustively tests connect/disconnect against a real temp `.claude/settings.json`: Global vs Project scope on connect, adding/narrowing/resetting the allowlist, `removeClaudeCodeOtlpConfig({scope:'project'})` removing only the current project (via `resolveProjectRoot()`), backup/restore round-trips, ownership-by-value guards, orphaned-hook cleanup. **Only supports removing the current working directory's project — no path for an arbitrary project, and no "Global + exclusion list" concept.**
- `src/cli/commands/proxy/__tests__/disconnect-orchestrator.test.ts`, `connect-orchestrator.test.ts`, `connect-wiring.test.ts` — orchestration-layer tests via `vi.doMock` + `vi.resetModules()` + dynamic `import()`.
- `src/cli/commands/proxy/prompts/__tests__/analytics-confirmation.test.ts` — tests the inquirer confirm/decline prompt and message builder.
- `src/cli/commands/proxy/__tests__/index.test.ts` — commander wiring tests for the `proxy` command group.
- No existing test exercises disabling an arbitrary (non-cwd) project, a "disable all" command distinct from `disconnect`, or any Global-scope-with-exclusion concept — all because this functionality does not yet exist.
- No standalone test file exists for `src/agents/core/project-allowlist.ts` in isolation (only reached transitively via the Claude wrapper test).

### Testing Framework and Patterns

- Framework: Vitest `^4.1.5` (`package.json`); config at root `vitest.config.ts`.
- **Dynamic-import-after-mock**: top-level `vi.mock(...)` followed by `const { X } = await import('../module.js')`, used to dodge ESM import-hoisting/TDZ issues.
- **`vi.doMock` + `vi.resetModules()` + inline `await import(...)` per test** for orchestrator-level connector swapping.
- **`vi.hoisted(() => vi.fn())`** for mocks referenced inside `vi.mock()` factories (e.g. inquirer's `prompt`).
- **Real filesystem over temp dirs** (`mkdtemp(join(tmpdir(), 'codemie-otlp-...'))`) is the dominant pattern for connector-level config read/write tests, rather than mocking `fs` wholesale. Only targeted `fs/promises` function wrapping (e.g. `unlink`) simulates specific failures.
- **Mocking `resolveProjectRoot`/`resolveHomeDir`** to redirect "cwd" and "home" into temp dirs, rather than chdir'ing the process.
- The real allowlist-parsing code path is exercised directly against real temp-dir JSON files; only the plugin-dispatch test mocks the allowlist module wholesale (since it cares about dispatch, not parsing).
- House convention: `describe('regression: EPMCDME-XXXXX — ...')` labeling with ticket/finding references in comments — new tests for this ticket should follow the same convention.

### Coverage Gaps

1. No "Global scope + project exclusion" model exists at all — zero test coverage because the feature doesn't exist yet (central gap this ticket must close).
2. No CLI-level test for disabling a specific (non-cwd) project — `removeClaudeCodeOtlpConfig({scope:'project'})` always targets `resolveProjectRoot()`.
3. No test file for `project-allowlist.ts` primitives in isolation — any new exclusion-list primitives added there would start from a transitively-tested baseline only.
4. No CLI command test for a "disable all analytics globally" entrypoint distinct from the existing full-teardown `disconnect` flow.
5. No regression test yet for AC4's requirement to verify native Claude Code launches alongside disable/enable state transitions.

---

## 5. Configuration and Environment

### Environment Variables

- `CODEMIE_ANALYTICS_PROJECT_FILTER` (constant `CODEMIE_ANALYTICS_PROJECT_FILTER_ENV` in `claude-code-otlp.allowlist.ts`) — JSON-stringified array of absolute project paths, stored in Claude's own `settings.json` under `env`. This is the existing allowlist mechanism and the closest prior art for "disable for specific project," but it is inclusion-only.
- `CODEMIE_HOME` — overrides `~/.codemie` root (`src/utils/paths.ts::getCodemieHome()`/`getCodemiePath()`), used for CodeMie's own per-user state — not where the analytics allowlist currently lives, but the natural home for a new analytics-preferences file.
- `CODEMIE_SESSION_ANALYTICS_REPORT` — suppresses a different, unrelated session-level report (not project-scoped, not OTLP) — worth knowing only to avoid new naming collisions.
- `CODEMIE_SKILLS_SH_TELEMETRY` / `CODEMIE_CAPTURE_SKILLS_SH_INSTALL_TELEMETRY` — unrelated skills-install telemetry, not analytics/OTLP related.
- `CODEMIE_SESSION_SYNC_ENABLED` — analogous existing "disable via env/profile/default priority" pattern for a different pipeline (managed session sync via the SSO proxy plugin, `ARCHITECTURE-PROXY.md` §6.12) — architecturally independent of the hook/OTLP/`isTracked` pipeline. Genuinely open question: does "disable all analytics" need to also silence this channel? (See Section 6.)

### Configuration Files

- `config.example.json` (repo root) — top-level CLI config schema (provider, baseUrl, apiKey, model, timeout, debug, allowedDirs, ignorePatterns). No analytics/scope section exists here; not the right place for new state.
- `~/.claude/settings.json` — Claude Code's own settings file; CodeMie currently writes hooks + OTEL env vars + the allowlist filter into it. Shared ownership with the user's own settings — risky to overload further with a "disabled" flag.
- Project-local `.claude/settings.json` under cwd — written when `--scope project` is used by connect/disconnect, parallel to the user-level file for `--scope user`.
- No existing CodeMie-owned JSON file for Claude Code analytics preferences exists yet; `src/agents/core/copilot-connector-scope.ts`'s file (via `getCodemiePath`) is the closest analog and recommended template.

### Feature Flags and Deployment Concerns

- No boolean "analytics enabled/disabled" global flag exists today for Claude Code OTLP. The closest analogue — "empty/absent allowlist = track everything (Global)" — is the opposite of "disabled," so a true disable-all state requires new persisted state (a sentinel/new flag), not a redefinition of empty-array semantics (which would be a breaking change to current Global-scope meaning).
- Hook installation/removal logic lives entirely in `connectors/claude-code-otlp.ts` (rewrites the `hooks` map for 8 Claude Code event types); hooks remain on disk and keep firing until explicitly uninstalled via `disconnect`. Any "disable" feature must ensure these still-installed hooks short-circuit at `isTracked()` rather than relying on allowlist semantics that cannot currently express "disable everything" — this is the direct mechanism AC3's "previously installed global hooks" requirement is about.

---

## 6. Risk Indicators

- **Core mechanism gap**: no existing "track all except X" (Global + exclusion) concept anywhere in the codebase (neither Claude's allowlist nor Copilot's connector-scope model supports it) — AC2 requires building this from scratch, not just exposing an existing primitive via new CLI.
- **No existing "disable without uninstall" state**: current `disconnect` either fully tears down hook wiring or narrows an inclusion list by the cwd's project only — AC1/AC3's "without removing or reinstalling" requirement needs genuinely new persisted state and a new read path inside `isTracked()`.
- **Settings-file ownership risk**: `~/.claude/settings.json` is shared with Claude Code's own settings; further overloading its `env` values for a new disable flag increases risk of collision/corruption — recommend a new CodeMie-owned JSON file (via `getCodemiePath`, following `copilot-connector-scope.ts`'s pattern) instead.
- **Command namespace collision risk**: `codemie analytics` already exists as an unrelated reporting/metrics command — a new collection-control subcommand group must be named/nested to avoid user confusion (e.g. under `codemie proxy`).
- **Open scope question not yet resolved**: whether "disable all analytics" must also silence the architecturally separate SSO Session Sync Plugin / `CODEMIE_SESSION_SYNC_ENABLED` channel (managed-session metrics/conversation sync) in addition to the OTLP hook/`isTracked` pipeline. This is flagged as a genuine open decision in the prior work-item doc and corroborated by `ARCHITECTURE-PROXY.md` §6.12 — needs resolution before/during planning, not assumed either way.
- **No test coverage for arbitrary non-cwd project disable** — the only existing project-removal test path operates on `resolveProjectRoot()` (cwd); if the new CLI command accepts an explicit project path argument, there's no existing pattern to extend directly (though the connector test file's structure is a good template).
- **Unverified claim**: whether `getClaudeSettingsPath()` honors a `CLAUDE_CONFIG_DIR` override or hardcodes `~/.claude` — flagged by prior investigation, not independently confirmed in this run; should be checked directly during implementation planning since it affects where a "project launched in a non-default Claude config dir" would read scope from.
- **AC4 regression breadth**: covering Project scope, Global scope, and native Claude Code launches for both disable-all and disable-one-project, while proving non-interference between projects, is a materially larger test surface than existing coverage (which tests connect/disconnect, not disable/enable toggling).

---

## 7. Summary for Complexity Assessment

This task touches four layers: the hook/adapter layer (`claude-code-otlp.plugin.ts`'s `isTracked()`, and likely new logic in `project-allowlist.ts` or a new sibling module for exclusion matching), a new config/storage layer (a new CodeMie-owned JSON preferences file, following the `copilot-connector-scope.ts` persistence pattern, read at hook-invocation time), the CLI command layer (`src/cli/commands/proxy/*`, which needs a new subcommand group for disable/enable/status that must avoid collision with the existing unrelated `codemie analytics` reporting command), and the test layer (new unit tests for exclusion-list primitives, new CLI orchestrator tests, and new regression tests spanning Project/Global scope and native launches per AC4). Core, SSO-dispatch, and daemon code (`OtlpAgentAdapter.ts`, `otlp.plugin.ts`) should NOT need modification — the existing `isTracked`-before-everything invariant already structurally satisfies AC1's "no SSO solely for analytics" requirement, so the main engineering work is additive: new state, a new read path into `isTracked()`, and new CLI surface. Estimated file-change surface is moderate: 1-2 new files (preferences config module + its allowlist/exclusion logic), edits to `claude-code-otlp.plugin.ts`/`claude-code-otlp.allowlist.ts` (or a new sibling file) to add the exclusion-aware tracked-check, 1-2 new or extended CLI command files under `src/cli/commands/proxy/`, and several new/extended test files.

Technical novelty is moderate-to-high: while the codebase has strong analogous patterns to follow (the `copilot-connector-scope.ts` persistence model, the existing inclusion-allowlist primitives in `project-allowlist.ts`, and the CLI orchestrator/connector split), the specific feature this ticket needs — a Global-scope tracking mode that can still exclude named projects, plus a genuinely new "disabled without uninstall" state — has zero precedent anywhere in this codebase (Claude or Copilot paths). This is new design work layered onto well-understood extension points, not a novel architecture, but it is not a simple copy-paste of an existing pattern either.

Test coverage posture for the affected area is good but narrow: `claude-code-otlp.allowlist.test.ts`, `claude-code-otlp.plugin.test.ts`, and `connectors/__tests__/claude-code-otlp.test.ts` thoroughly cover the *current* inclusion-only, connect/disconnect behavior with established Vitest conventions (temp-dir real I/O, dynamic-import mocking, `vi.doMock`+`vi.resetModules()`), but there is zero existing coverage for the exclusion/disable concepts this ticket introduces, and AC4 explicitly requires broader regression coverage (Project scope, Global scope, native launches, and non-interference between projects) than anything currently tested. Key risk factors for complexity scoring: the unresolved SSO-session-sync scope question (could expand surface area if in scope), the settings-file-ownership risk of touching `~/.claude/settings.json` further, and the namespace-collision risk with the existing `codemie analytics` command — all of which should be resolved during spec/design before implementation estimation is finalized.
