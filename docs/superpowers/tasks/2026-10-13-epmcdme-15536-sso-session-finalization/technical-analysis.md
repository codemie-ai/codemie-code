# Technical Research

**Task**: session lifecycle claude plugin reconciliation stale-session
**Generated**: 2026-10-13
**Research path**: filesystem (codegraph MCP not available in this environment)

---

## 1. Original Context

EPMCDME-15536 [CLI Analytics] SSO-proxied session lifecycle prevents analytics collection and reporting. Sessions launched via the `claude` agent plugin routed through the ai-run-sso proxy gateway permanently stay `status: "active"` with no `endTime` in ~/.codemie/sessions/{id}.json when the Claude Code process does not exit cleanly (killed terminal, crashed process, OS sleep/shutdown, SSH disconnect) — because finalization for this plugin depends entirely on Claude Code's own `SessionEnd` hook firing and calling `codemie hook` -> `SessionStore.updateSessionStatus`. This codebase already has a documented fallback for exactly this failure mode in `src/agents/core/session/stale-session-reconciliation.ts` (`reconcileStaleSessions`), which synthesizes a `SessionEnd` event with `reason: "interrupted"` for stranded sessions of an agent's own kind, called from that agent's `onSessionStart`. That fallback is currently wired up ONLY for the `codex` plugin (via `src/agents/plugins/codex/codex.reconciliation.ts`) and the `pi` plugin (`src/agents/plugins/pi/pi.plugin.ts` line ~392 calling `reconcileStaleSessions('pi', env, buildPiHookConfig)`). It is NOT wired into `src/agents/plugins/claude/claude.plugin.ts` (903 lines, confirmed no `onSessionStart` or `reconcileStaleSessions` reference at all), nor into `codemie-code.plugin.ts`, `opencode/opencode.plugin.ts`, `copilot-cli/copilot-cli.plugin.ts`, `kimi/kimi.plugin.ts`, or `gemini/gemini.plugin.ts` — all of which DO implement `onSessionStart`/`onSessionEnd` lifecycle hooks but without the reconciliation call. This was confirmed empirically against live session data on this machine: 10 of 36 local sessions in ~/.codemie/sessions/ are `provider: "ai-run-sso", agentName: "claude"`, `status: "active"`, with no `endTime`, some stuck since 2026-09-30 (13+ days). It was also confirmed that `codemie analytics --export json` (current CLI code, aggregator.ts) does NOT exclude active sessions that have real recorded metrics/deltas — only zero-delta (truly empty) sessions are excluded regardless of status — so the primary, in-scope fix is specifically the session-finalization/fallback gap for the `claude` plugin (and the other unwired plugins), not the analytics export filter.

---

## 2. Codebase Findings

### Existing Implementations

**Core reconciliation module** — `src/agents/core/session/stale-session-reconciliation.ts` (195 lines, agent-generic, no changes needed to support claude):

```ts
export async function findStaleSessions(
  agentName: string,
  opts: ReconciliationOptions = {},
): Promise<StaleSession[]>

export async function reconcileStaleSessions(
  agentName: string,
  env: NodeJS.ProcessEnv,
  buildHookConfig: (env: NodeJS.ProcessEnv, sessionId: string) => HookProcessingConfig,
  opts: ReconcileOptions = {},
): Promise<{ reconciled: number; failed: number }>
```

- `ReconciliationOptions`: `inactivityThresholdMs` (default `30 * 60 * 1000`), `maxLookbackMs` (default `24 * 60 * 60 * 1000`), `now` (test clock override). Both thresholds are **hardcoded module constants**, not read from env/config.
- `ReconcileOptions extends ReconciliationOptions` adds `processEvent` (injectable for tests; defaults to real `processEvent` from `src/cli/commands/hook.ts` via dynamic import).
- Stale criteria in `findStaleSessions`: file is a `.json` session record (not `completed_*`/`*_metrics`/`*_conversation`), `session.agentName === agentName` (exact match — this is what scopes reconciliation to only touch sessions of the calling agent's own kind), `status === 'active'`, `startTime` within `maxLookbackMs` of now, and `computeLastActivity(session)` (max of `startTime` and various `sync.*.lastSyncAt`/`lastProcessedTimestamp` fields) older than `inactivityThresholdMs`.
- Synthesized event (verbatim):
  ```ts
  const event: SessionEndEventLike = {
    hook_event_name: 'SessionEnd', session_id: entry.sessionId, transcript_path: '',
    permission_mode: 'default', cwd: process.cwd(), reason: 'interrupted',
  };
  await processEvent(event, buildHookConfig(env, entry.sessionId));
  ```
  Per-entry failures increment a `failed` counter and are logged, never thrown — reconciliation is designed to be fire-and-forget and non-blocking.

**`buildHookConfig` contract** — any new `buildClaudeHookConfig` must match this shape (identical across codex/pi):
```ts
(env: NodeJS.ProcessEnv, sessionId: string) => ({
  agentName: env.CODEMIE_AGENT || '<agent-literal>',
  sessionId, provider: env.CODEMIE_PROVIDER, apiBaseUrl: env.CODEMIE_BASE_URL,
  ssoUrl: env.CODEMIE_URL, syncApiUrl: env.CODEMIE_SYNC_API_URL,
  version: env.CODEMIE_CLI_VERSION, profileName: env.CODEMIE_PROFILE_NAME,
  project: env.CODEMIE_PROJECT, model: env.CODEMIE_MODEL,
  clientType: 'codemie-claude',  // matches ClaudePluginMetadata's existing ssoConfig.clientType
})
```

**Existing wiring (codex)** — `src/agents/plugins/codex/codex.reconciliation.ts` is a thin per-agent wrapper (`reconcileStaleCodexSessions` → delegates to `reconcileStaleSessions('codex', ...)`). Called from `codex.plugin.ts` line 207, inside `lifecycle.onSessionStart`, fire-and-forget with `.catch()` logging at `logger.debug`.

**Existing wiring (pi)** — `src/agents/plugins/pi/pi.plugin.ts` imports `reconcileStaleSessions` directly (no wrapper file) and calls it inline at line 392 inside `async onSessionStart(sessionId, env) { ... }`, also fire-and-forget with `.catch()`.

**`claude.plugin.ts` — confirmed critical gap**: 903 lines, only 3 top-level exports (`CLAUDE_SUPPORTED_VERSION`, `ClaudePluginMetadata: AgentMetadata`, `class ClaudePlugin extends BaseAgentAdapter`). Its `lifecycle: { ... }` object (lines 221–585) defines **only** `beforeRun` (223) and `afterRun` (554) — **no `onSessionStart`/`onSessionEnd` exists anywhere in the file.** This is not a missing-call-only gap like codex/pi were before being wired — it is a missing-hook gap. `grep` for `onSessionStart`/`onSessionEnd` in `claude.plugin.ts` returns zero matches.

**Where claude sessions are actually initialized/finalized today**: Claude Code (the upstream binary) fires its own *native* hook events, configured via a Claude-Code plugin manifest at `src/agents/plugins/claude/plugin/hooks/hooks.json`, which maps `SessionStart`/`SessionEnd`/etc. to shelling out to `codemie hook` as a separate subprocess. The wiring chain:
1. `src/providers/core/default-agent-hooks.ts`'s provider-agnostic `beforeRun` (`defaultAgentHooks['*']`) calls `agent.getExtensionInstaller().install()` (installs `src/agents/plugins/claude/plugin/` to `~/.codemie/claude-plugin` via `ClaudePluginInstaller`), then `defaultAgentHooks['claude'].enrichArgs` injects `--plugin-dir <dir>` into the `claude` CLI invocation.
2. Claude Code loads `hooks/hooks.json` from that plugin dir at its own startup and invokes `codemie hook` on `SessionStart`/`SessionEnd`.
3. `src/cli/commands/hook.ts`'s `handleSessionEnd` is the ONLY code path that calls `SessionStore.updateSessionStatus(sessionId, 'completed', event.reason)` for claude sessions today — and it only runs if the external `claude` process actually emits `SessionEnd`.
4. Separately, in the CLI's own in-process `AgentLifecycle` resolution (`src/agents/core/lifecycle-helpers.ts`, `executeOnSessionStart`, invoked by `BaseAgentAdapter.run()`), neither `claude.plugin.ts`'s `lifecycle` object nor `defaultAgentHooks['claude']` define `onSessionStart` — so for every `codemie claude` launch, `lifecycle-helpers.ts` logs "No onSessionStart hook found" and reconciliation never has a chance to run.

This is the exact mechanism the ticket describes: finalization is 100% dependent on the external Claude Code process cleanly emitting `SessionEnd`, with no in-process fallback standing in when it doesn't.

### Architecture and Layers Affected

- **Agent/Plugin layer** (`src/agents/plugins/claude/claude.plugin.ts`) — needs a new `onSessionStart` added to its `lifecycle` object (or equivalently to `src/providers/core/default-agent-hooks.ts`'s `agentHooks['claude']`), mirroring codex/pi's existing pattern.
- **Core session layer** (`src/agents/core/session/stale-session-reconciliation.ts`) — already agent-generic; unit tests already exercise it with `'claude'` as a plain string `agentName` argument (`core-misc.test.ts:526,550`). No changes needed here.
- **Lifecycle resolution layer** (`src/agents/core/lifecycle-helpers.ts`, `src/agents/core/types.ts`'s `AgentLifecycle`/`ProviderLifecycleHooks` interfaces) — defines the hook-resolution priority (provider hook wins over agent default). Relevant for deciding WHERE to add the new hook.
- **CLI hook-command layer** (`src/cli/commands/hook.ts`) — alternative, more centralized wiring point if reconciliation were instead triggered once per `codemie hook SessionStart`/native-hook invocation rather than per in-process `AgentLifecycle.onSessionStart`. Not currently used by any plugin's reconciliation wiring, but is the layer that already owns `SessionStore.updateSessionStatus` for the SessionEnd path.
- **Provider layer** (`src/providers/core/default-agent-hooks.ts`, `src/providers/plugins/sso/sso.template.ts`) — the ai-run-sso provider template spreads `defaultAgentHooks`, so a provider-level fix here would apply across all providers using claude, not just SSO specifically. The ticket's premise is specific to the `ai-run-sso` provider case, but the plugin-level gap is provider-agnostic (any claude session hard-killed, regardless of provider, is affected the same way).

### Integration Points

- `reconcileStaleSessions` reads session files from `~/.codemie/sessions/` via `getCodemiePath('sessions')` — pure filesystem, no network calls directly, but the default (non-injected) `processEvent` dynamically imports `src/cli/commands/hook.ts`, which on `SessionEnd` performs `syncPendingDataToAPI` (network, deadline-bounded by `CODEMIE_SESSION_END_SYNC_BUDGET_MS`, default 2000ms) in addition to the `SessionStore.updateSessionStatus` call.
- Session record's `provider` field is populated at `SessionStart` time in `hook.ts`'s `createSessionRecord()` from `CODEMIE_PROVIDER` env (set from the active profile's `config.provider`); `ai-run-sso` is the literal value stored. `findStaleSessions` filters only on `agentName`/`status`/timestamps — NOT on `provider` — so wiring claude's reconciliation generically will also catch non-SSO claude sessions that are stranded, which is desirable and matches the generic design already used by codex/pi.
- `HookProcessingConfig.clientType` must be `'codemie-claude'` for correct metrics attribution — this literal already exists in `ClaudePluginMetadata`'s `ssoConfig.clientType` (line 165), so a new `buildClaudeHookConfig` should reuse/match it.

### Patterns and Conventions

- Two valid, already-precedented wiring shapes exist in this codebase — no single hard convention:
  1. **codex pattern**: dedicated `<plugin>.reconciliation.ts` wrapper file exporting a thin per-agent-bound function, called from the plugin's `onSessionStart`.
  2. **pi pattern**: direct inline import and call of `reconcileStaleSessions('pi', env, buildPiHookConfig)` inside `onSessionStart`, with `buildPiHookConfig` defined locally in the plugin file.
  Either is acceptable for claude; pi's pattern is less code (no new wrapper file) and claude currently has zero wrapper infrastructure, so following pi's direct-inline pattern is likely the lower-friction choice — but codex's wrapper pattern is more testable in isolation (as the existing `codex.reconciliation.test.ts` demonstrates).
- Fire-and-forget + non-blocking `.catch()` logging at `logger.debug`/`logger.warn` is a hard convention across both existing call sites — a new claude wiring must follow this (never block or fail session launch on reconciliation errors).
- `AgentLifecycle`/`ProviderLifecycleHooks` (`src/agents/core/types.ts`) are plain optional-method object shapes, not a base class — there is no `BasePlugin` to extend, so centralizing reconciliation generically inside `lifecycle-helpers.ts`'s hook-resolution path (calling it for every agent before/after the plugin's own `onSessionStart`) is architecturally possible but is NOT how codex/pi did it, and would still miss claude/kimi/gemini unless those also gain an `onSessionStart` entry point — centralization doesn't eliminate the need to add the hook itself for claude.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/integration/external-integrations.md` (line ~227) has an explicit "Stale-session reconciliation" subsection, but **it only documents the codex case** — it describes `reconcileStaleCodexSessions`/`codex.reconciliation.ts` and a troubleshooting-table row for codex, with no mention of pi (which is already wired in code) or claude. This guide is stale/incomplete relative to current code.
- `.ai-run/guides/architecture/architecture.md` does not define the `AgentLifecycle`/plugin lifecycle contract at all (no hits for `onSessionStart`/`onSessionEnd`/"lifecycle hook").
- Root `AGENTS.md` self-documents a known gap: "Neither `.ai-run/guides/integration/external-integrations.md` nor `docs/AGENTS.md` covers Pi yet... read `src/agents/plugins/pi/` directly" — confirming the project's own convention is "guides may lag code; verify directly against plugin source," which this research followed.
- `docs/superpowers/tasks/2026-10-13-epmcdme-15536-sso-session-finalization/` (this run's own task folder) currently contains only `.state.json` — no prior spec/plan/technical-analysis to reuse.

### Architectural Decisions

- No ADR/DECISION-tagged comment exists anywhere explaining why claude (or kimi/gemini) is excluded from reconciliation. The real reason, reconstructed from code rather than stated as a decision: **claude's session lifecycle is driven by Claude Code's own native hook system (external subprocess calling `codemie hook`), not by this CLI's in-process `AgentLifecycle.onSessionStart`** — so the "add a call inside onSessionStart" pattern used for codex/pi simply had no hook to attach to for claude.
- `stale-session-reconciliation.ts`'s header comment (lines 1–16) is the canonical design rationale: hard-killed runs never reach `onSessionEnd`; stranded sessions stay `active` forever with no terminal metric; the agent-generic design scans for stranded sessions "of its own kind" on its next `onSessionStart`; 30-minute inactivity threshold and 24-hour lookback cap are explicitly chosen "so a first deploy does not emit a burst of synthetic events for ancient stranded sessions."
- `codex.reconciliation.ts`'s header comment explains the wrapper-file choice is a naming/binding convenience, not an architectural necessity — "the logic is agent-generic... this module only binds it to the `codex` agent name."
- No CHANGELOG.md entry exists anywhere for the reconciliation feature (not even under `[Unreleased]`) — it was shipped without a changelog note for either codex or pi.

### Derived Conventions

- Core generic logic lives under `src/agents/core/session/`; plugin-specific binding is either a wrapper file (codex) or an inline call (pi) — both precedented, pick either for claude.
- `clientType` literals follow `'codemie-<agent>'` naming (`codemie-codex`, `codemie-pi`, and already `codemie-claude` in `ClaudePluginMetadata.ssoConfig`).
- Guides are known to lag plugin code; this analysis prioritized direct source reading over `.ai-run/guides/` content where they diverged.

---

## 4. Testing Landscape

### Existing Coverage

- **Core module** — `src/agents/core/__tests__/core-misc.test.ts` (describe block at line 343) tests `findStaleSessions`/`reconcileStaleSessions` directly and thoroughly: empty/missing sessions dir, staleness-by-last-activity (not just startTime), agentName/status/lookback filtering, skipping non-session/corrupt files, custom threshold options, zero-stale case, per-session synthesized-event field assertions (`hook_event_name`, `reason`, `permission_mode`, `cwd`), and per-session failure counting without aborting the loop. Notably, this file already calls `reconcileStaleSessions('claude', ...)` (lines 526, 550) as a plain string argument — proving the core function requires zero changes to support claude.
- **codex wrapper** — `src/agents/plugins/codex/__tests__/codex.reconciliation.test.ts` tests `codex.reconciliation.ts` (the thin wrapper), re-implementing local `makeSession`/`writeSession` fixtures, exercising the real implementation end-to-end against a temp sessions dir with injected `processEvent`/`buildHookConfig`. Key assertions: `{ reconciled: N, failed: N }` shape, `reason === 'interrupted'` on every synthesized event, and that `processEvent` is never invoked when nothing is stale.
- **pi wiring** — **no test exists** anywhere for pi's `onSessionStart` call site or its use of `reconcileStaleSessions`.
- **codex plugin call site** — **also untested at the call-site level.** `codex.plugin.lifecycle.test.ts` exists but has zero references to `reconcile*` — it only tests the thin wrapper module, not the actual `onSessionStart` invocation inside `codex.plugin.ts`.
- **claude.plugin.ts existing tests** — `src/agents/plugins/claude/__tests__/` contains `claude.plugin.conflict.test.ts`, `claude.plugin.subagent-warning.test.ts`, `claude.plugin.statusline.test.ts`, `claude.plugin.tool-search.test.ts`, `claude.plugin.auto-update.test.ts`, `claude.plugin.model-swap-warning.test.ts`, `claude.provider-support.test.ts`, plus adjacent `ClaudeSessionAdapter.test.ts`, `claude.conversations-processor.test.ts`, `claude.models.test.ts`. All cover `beforeRun`-time logic or session/transcript parsing — **none touch lifecycle wiring or reconciliation.** No test file for claude's reconciliation exists because the hook itself doesn't exist yet.

### Testing Framework and Patterns

- vitest ^4.1.5, `vitest.config.ts` defines 3 named projects: `unit` (`src/**/*.test.ts`), `cli` (`tests/integration/**/*.test.ts`), `agent` (network/SSO-gated integration tests). Unit project: `globals: true`, `environment: 'node'`, 30s timeouts, per-process `CODEMIE_HOME` tmpdir, path alias `@` → `/src`.
- No shared mock/fixture factory for sessions exists — every test file (`core-misc.test.ts`, `codex.reconciliation.test.ts`, and several others) hand-rolls its own local `makeSession()`/`writeSession()` helpers.
- Standard isolation convention: `mkdtempSync(join(tmpdir(), 'codemie-recon-'))` set as `process.env.CODEMIE_HOME` in `beforeEach`, cleaned up via `rmSync` in `afterEach`.
- `@/utils/logger.js` is routinely mocked repo-wide via `vi.mock` returning no-op functions.
- The closest existing precedent for testing a *plugin-level wiring call site* (as opposed to the core function) is `codex.plugin.lifecycle.test.ts`'s `vi.doMock(...)` + `vi.resetModules()` + dynamic `await import(...)` pattern used to intercept the hook-processing module per-test — this would need to be generalized/reused to mock `reconcileStaleSessions` itself and assert claude's new `onSessionStart` calls it with `'claude'` and a correct `buildClaudeHookConfig`.

### Coverage Gaps

- No test exists for claude's reconciliation wiring — because the wiring (and even the `onSessionStart` hook) doesn't exist yet.
- No test exists for pi's plugin-level wiring (only the generic core function is tested with pi-shaped data via `core-misc.test.ts`).
- No test exists for codex's plugin-level call site either — only its thin wrapper module is unit-tested. There is **no existing precedent in this repo for "assert a plugin's onSessionStart calls reconcileStaleSessions with the right agentName/buildHookConfig."** A new test for claude would be establishing a first-of-its-kind pattern at the plugin-call-site level, not just following an existing one.
- No tests exist anywhere for `codemie-code.plugin.ts`, `opencode.plugin.ts`, `copilot-cli.plugin.ts` regarding reconciliation (consistent with them being unwired too).

---

## 5. Configuration and Environment

### Environment Variables

- `CODEMIE_PROVIDER` — generic provider-id env var, set from the active profile's `config.provider` in `src/utils/config.ts` before the agent process spawns. Carries the literal `"ai-run-sso"` for the SSO proxy case described in the ticket. No `ai-run-sso`-specific env var exists.
- `CODEMIE_AGENT` — identifies which agent/plugin `codemie hook` is processing for; used to look up the agent in `AgentRegistry` and to drive event-name mapping.
- `CODEMIE_SESSION_END_SYNC_BUDGET_MS` (default 2000ms) — bounds the `syncPendingDataToAPI` step inside `handleSessionEnd`, abortable on SIGTERM/SIGINT.
- `CODEMIE_CLAUDE_EXTENSION_DIR` — set by `defaultAgentHooks['*'].beforeRun` after installing the claude plugin dir; consumed by `defaultAgentHooks['claude'].enrichArgs` to inject `--plugin-dir`.
- No env var exists to configure the staleness thresholds (`inactivityThresholdMs`/`maxLookbackMs`) — they are hardcoded constants in `stale-session-reconciliation.ts`.

### Configuration Files

- `config.example.json` — generic single-provider example only (`provider`, `baseUrl`, `apiKey`, `model`, `timeout`, `debug`, `allowedDirs`, `ignorePatterns`); no `ai-run-sso`-specific or session/reconciliation fields.
- No `.env.example` file exists anywhere in the repo.
- `src/agents/plugins/claude/plugin/hooks/hooks.json` — the Claude-Code-native plugin manifest registering `"command": "codemie hook"` for `SessionStart`/`SessionEnd`/etc. with `timeout: 60` each. This is installed to `~/.codemie/claude-plugin` at every run via `ClaudePluginInstaller`.
- `src/providers/plugins/sso/sso.template.ts` — the `ai-run-sso` provider template, spreads `agentHooks: defaultAgentHooks` (so any provider-level fix in `default-agent-hooks.ts` would apply here too).

### Feature Flags and Deployment Concerns

- No feature flag, opt-in config key, or toggle gates whether a plugin wires `reconcileStaleSessions` — it is purely a matter of whether the plugin's source defines `onSessionStart` and calls it. No deployment-manifest or Docker concerns are implicated by this change (pure in-process TS logic).

---

## 6. Risk Indicators

- **`claude.plugin.ts` has no `onSessionStart` hook at all** — this is a bigger change than "add one line inside an existing hook" (as it was for codemie-code/opencode/copilot-cli). A new lifecycle method must be added to `ClaudePluginMetadata.lifecycle`, consistent with the `AgentLifecycle` interface in `src/agents/core/types.ts`.
- **Scope correction needed relative to the ticket's premise**: the ticket states kimi and gemini "DO implement onSessionStart/onSessionEnd lifecycle hooks... but without the reconciliation call." Research found this is **inaccurate** — `kimi.plugin.ts` and `gemini.plugin.ts` have **zero `onSessionStart` hooks**, same architectural shape as claude (native-hook/subprocess-driven via `hookConfig.eventNameMapping`), not a one-line-addition case. Only `codemie-code.plugin.ts`, `opencode.plugin.ts`, and `copilot-cli.plugin.ts` are true "has the hook, missing the call" cases. This should be flagged explicitly during spec/planning so scope decisions (claude-only vs. claude+kimi+gemini) are made deliberately.
- **Design-location ambiguity**: reconciliation could be added to `claude.plugin.ts`'s own `lifecycle.onSessionStart` (agent-default, mirrors codex/pi, always fires via `BaseAgentAdapter.run()` regardless of provider) OR to `src/providers/core/default-agent-hooks.ts`'s `agentHooks['claude']` (provider-level, shared across all provider templates that spread `defaultAgentHooks`, including `ai-run-sso`). Hook-resolution priority favors provider hooks over agent defaults, so the two are not interchangeable; the agent-default location is recommended for parity with existing codex/pi precedent and guaranteed coverage regardless of provider, but this is a decision point for the spec phase, not something this research resolves unilaterally.
- **No existing test precedent at the plugin-call-site level** — neither codex nor pi has a test that mocks `reconcileStaleSessions` and asserts the plugin's `onSessionStart` invokes it correctly. A new claude test would need to establish this pattern (the closest reusable scaffold is `codex.plugin.lifecycle.test.ts`'s `vi.doMock`/`vi.resetModules`/dynamic-import style).
- **Guides are stale**: `.ai-run/guides/integration/external-integrations.md` documents only the codex reconciliation case and will need an update once claude (and possibly kimi/gemini) are wired, to avoid the guide lagging code further (as it already lags the pi wiring).
- **No CHANGELOG convention established** for this feature — neither codex nor pi's reconciliation addition has a CHANGELOG entry, so there's no established format to follow if one is desired here.
- **Staleness thresholds are hardcoded, not configurable** — any claude-specific tuning (e.g. if claude sessions have different typical idle patterns than codex/pi) would require either passing explicit `opts` at the call site or a broader config change; out of scope unless the spec calls for it.
- **`clientType` consistency**: a new `buildClaudeHookConfig` must use `clientType: 'codemie-claude'` to match the literal already present in `ClaudePluginMetadata.ssoConfig` — a mismatch would cause incorrect metrics attribution for the synthesized `SessionEnd` events.
- **`agentName` exact-match scoping is a safety feature, not a risk** — confirmed that wiring `reconcileStaleSessions('claude', env, buildClaudeHookConfig)` will only ever touch sessions where `agentName === 'claude'`, regardless of `provider` value, so it correctly covers the `ai-run-sso`-provider claude sessions described in the ticket without needing provider-specific filtering logic.

---

## 7. Summary for Complexity Assessment

This task touches two architectural layers directly: the **Agent/Plugin layer** (`src/agents/plugins/claude/claude.plugin.ts`, requiring a brand-new `onSessionStart` method on its `lifecycle` object — not a one-line insertion into an existing hook, since no such hook currently exists) and the **Testing layer** (a new test file/suite for claude's reconciliation wiring, which has no existing plugin-call-site-level precedent in this codebase to copy verbatim — the closest reusable scaffold, `codex.plugin.lifecycle.test.ts`'s `vi.doMock`/dynamic-import pattern, tests a different thing and would need adaptation). The core reconciliation engine (`stale-session-reconciliation.ts`) is already agent-generic, fully implemented, and already exercised in existing unit tests with `'claude'` as a literal agentName argument — so no core-layer changes are needed, which caps the blast radius considerably. Estimated file-change surface is small-to-moderate: likely 1 plugin file edit (claude.plugin.ts, adding ~20-30 lines mirroring pi's inline pattern or codex's wrapper-file pattern), optionally a new `claude.reconciliation.ts` wrapper file if the codex pattern is preferred, 1 new test file, and possibly a guide update to `.ai-run/guides/integration/external-integrations.md`.

Technical novelty is low for the core mechanism (directly copies an existing, twice-precedented pattern) but there is a non-trivial design decision to make before implementation: whether to wire the new hook into the plugin's own `lifecycle` object (agent-default, provider-agnostic) or into `default-agent-hooks.ts`'s provider-level `agentHooks['claude']` — these have different hook-resolution precedence and provider-coverage implications, and this research did not find a strong existing-code mandate for one over the other (recommend agent-default for parity with codex/pi, but flag as a spec-phase decision). A secondary scope question — surfaced by this research but not assumed by the ticket — is whether kimi and gemini belong in this task's scope at all, since contrary to the ticket's description they have no `onSessionStart` hook either (identical architectural gap to claude, not the simpler "missing call" gap that codemie-code/opencode/copilot-cli have).

Test coverage posture for the affected area is mixed: the core reconciliation function itself is well-tested (thorough `core-misc.test.ts` coverage including edge cases), but there is zero precedent anywhere in the repo for testing a plugin's `onSessionStart` call site invoking `reconcileStaleSessions` correctly — both codex and pi ship this wiring untested at that level. Claude's own existing test suite (`claude.plugin.*.test.ts`) is extensive but entirely orthogonal (covers `beforeRun`-time concerns like auto-update, conflict detection, statusline, tool-search flags — nothing about session lifecycle). This means the implementer will be establishing a new testing pattern rather than following one, which is a moderate (not high) risk given the core function's existing robust coverage reduces what the new test actually needs to verify (primarily: "is reconcileStaleSessions called with 'claude' and a correctly-shaped buildHookConfig, fire-and-forget, non-blocking").
