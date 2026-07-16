# Technical Research

**Task**: analytics agentName session cli agents
**Generated**: 2026-07-16T00:00:00Z
**Research path**: filesystem

---

## 1. Original Context

Fix codemie analytics command to support all agents. The `codemie analytics` CLI command does not show usage data for new CLI agents: `codemie-claude`, `codemie-codex`, `codemie-gemini`, `codemie-kimi`, `codemie-opencode`. Root cause (confirmed): When a new agent runs, the session file written to `~/.codemie/sessions/<uuid>.json` records `agentName: claude` (the underlying process name) instead of `agentName: codemie-claude` (the wrapper name). The CodeMie wrapper identity is lost at session write time. The session write path must record the wrapper agent name, not the inner process name. Key files: `src/cli/commands/analytics/data-loader.ts` reads agentName from session files; need to find where session metadata is written (search for agentName assignments and session file write logic, likely in a session hook or session manager). Acceptance criteria: codemie analytics displays usage statistics for all 7 CLI agent types: codemie-cli, codemie-claude, codemie-codex, codemie-gemini, codemie-kimi, codemie-opencode, codemie_cli (legacy underscore variant). New agent sessions are correctly attributed by agent name. Existing codemie-cli behaviour is unchanged. Tests cover each new agent type appearing in analytics output.

---

## 2. Codebase Findings

### Existing Implementations

**Session write path — the root cause location:**

- `src/agents/core/BaseAgentAdapter.ts` line 511: `CODEMIE_AGENT: this.metadata.name`
  - This is where `CODEMIE_AGENT` is set in the subprocess environment. `this.metadata.name` is the plugin's short name (`claude`, `codex`, `gemini`, `kimi`, `opencode`), NOT the wrapper name (`codemie-claude`, etc.).
  - This env var is inherited by all lifecycle hooks that subsequently write the session file.

- `src/cli/commands/hook.ts` function `createSessionRecord()` (line 657–785):
  - Called from `handleSessionStart()` during the `SessionStart` lifecycle hook.
  - Reads `agentName = getConfigValue('CODEMIE_AGENT', config)` (line 660).
  - Writes a `Session` object to `~/.codemie/sessions/<uuid>.json` with `agentName` taken directly from `CODEMIE_AGENT`.
  - This is the primary write path for CodeMie-tracked sessions.

- `src/agents/core/session/ensure-session.ts` function `ensureSessionFile()` (line 11–77):
  - Secondary write path used by `codemie-code` (the OpenCode-based built-in) as a fallback when no session file exists at the end of a run.
  - Reads `agentName = env.CODEMIE_AGENT || defaultAgentName` (line 26).
  - The `defaultAgentName` parameter is passed as `BUILTIN_AGENT_NAME` (`'codemie-code'`) from the codemie-code plugin.

- `src/agents/core/session/SessionStore.ts`:
  - `saveSession()` writes the Session JSON to `~/.codemie/sessions/<sessionId>.json`.
  - No agentName transformation occurs here; it writes whatever the Session object carries.

**Session read / analytics path:**

- `src/cli/commands/analytics/data-loader.ts` `MetricsDataLoader.loadSession()` (line 190–261):
  - Reads `sessionMetadata.agentName` directly from the JSON file (line 205).
  - Constructs a `SessionStartEvent` using that raw value — no normalization or remapping is applied.

- `src/cli/commands/analytics/aggregator.ts` line 407:
  - `agentName: startEvent.agentName` — value passes through unmodified to `SessionAnalytics`.

- `src/cli/commands/analytics/data-loader.ts` `matchesFilter()` (line 286–332):
  - Agent filter calls `agentMatchesAnalyticsFilter(startEvent.agentName, filter.agentName)` (line 302).

- `src/cli/commands/analytics/cost/codex-agent.ts`:
  - `agentMatchesAnalyticsFilter()` — currently only handles `codex`/`codemie-codex` family matching explicitly; all other agents use exact-match (`session === filter`).
  - `isCodexFamilyAgent()` — codex-only family check.

**Agent plugin name constants (what CODEMIE_AGENT is set to today):**

| CLI wrapper invoked | `metadata.name` set in plugin | `CODEMIE_AGENT` written to session file |
|---|---|---|
| `codemie-claude` | `claude` (claude.plugin.ts line 63) | `claude` |
| `codemie-codex` | `codex` (codex.plugin.ts line 106) | `codex` |
| `codemie-gemini` | `gemini` (gemini.plugin.ts line 29) | `gemini` |
| `codemie-kimi` | `kimi` (kimi.plugin.ts line 34) | `kimi` |
| `codemie-opencode` | `opencode` (opencode.plugin.ts line 18) | `opencode` |
| `codemie-code` (built-in) | `codemie-code` (codemie-code.plugin.ts line 182) | `codemie-code` |

The `BUILTIN_AGENT_NAME = 'codemie-code'` is the only agent whose stored name already matches its wrapper name because it was designed as a standalone entity, not a wrapper around an inner process.

**Native session discovery (separate path):**

- `src/cli/commands/analytics/native-loader.ts`:
  - `NATIVE_AGENTS = ['claude', 'codex']` — only two native agents are scanned.
  - `synthesizeRawSession()` and `synthesizeCodexRawSession()` use the `agentName` from the `SessionDescriptor`, which comes from the adapter's `discoverSessions()`. These are untracked (non-CodeMie-wrapper) sessions; their agentName will be `claude` or `codex` naturally.

### Architecture and Layers Affected

**Layers touched by this fix:**

1. **Agent Plugin layer** (`src/agents/core/BaseAgentAdapter.ts`): The single line setting `CODEMIE_AGENT: this.metadata.name` is the source of truth for what gets stored. To preserve the wrapper identity, this value must be the wrapper name (e.g., `codemie-claude`) rather than the inner plugin name (`claude`).

2. **CLI Hook layer** (`src/cli/commands/hook.ts`): `createSessionRecord()` reads `CODEMIE_AGENT` and stores it. No changes needed here if the env var is corrected upstream, but the type comment on `Session.agentName` (currently annotated `// 'claude', 'gemini'`) would need updating.

3. **Session core types** (`src/agents/core/session/types.ts`): The `Session.agentName` field comment reads `// 'claude', 'gemini'` — misleading but structurally harmless; update the comment.

4. **Analytics filter layer** (`src/cli/commands/analytics/cost/codex-agent.ts`): `agentMatchesAnalyticsFilter()` must be extended to support all seven canonical agent name variants. Currently it only has explicit codex-family logic; other agents use bare exact match, which will break if `codemie-claude` is in the session but the user filters `--agent claude`.

5. **Analytics data-loader** (`src/cli/commands/analytics/data-loader.ts`): No structural changes needed; it reads whatever is in the session file. The fix flows through automatically once the upstream write is corrected.

### Integration Points

- `BaseAgentAdapter.run()` → sets `CODEMIE_AGENT` in env → passed to `spawn()` child process which fires hooks.
- `hook.ts createSessionRecord()` → reads `CODEMIE_AGENT` → `SessionStore.saveSession()` → `~/.codemie/sessions/<uuid>.json`.
- `hook.ts sendSessionStartMetrics()` / `sendSessionEndMetrics()` → uses `agentName` from `CODEMIE_AGENT` for API telemetry; changing this value also changes what the backend receives.
- `AgentRegistry.getAgent(agentName)` in `hook.ts performIncrementalSync()` (line 318) and `normalizeEventName()` (line 534): called with the `CODEMIE_AGENT` value. If `CODEMIE_AGENT` becomes `codemie-claude`, the registry must be able to resolve that name. Currently the registry maps `claude` → `ClaudePlugin`; it does NOT have a `codemie-claude` entry.
- `src/providers/plugins/sso/proxy/plugins/*.plugin.ts`: several proxy plugins also read `agentName` from the session or env; may propagate the new name to the backend.
- `src/cli/commands/analytics/native-loader.ts`: `NATIVE_AGENTS` array and the `synthesizeRawSession` calls — these are for bare `claude`/`codex` (non-wrapper) runs; no change needed here.
- `src/cli/commands/analytics/cost/codex-agent.ts`: the `isCodexFamilyAgent()` function is called from `native-loader.ts` and `cost-enricher.ts` to select the correct parser. If `codemie-codex` sessions are now written as `codemie-codex`, `isCodexFamilyAgent()` must continue to match them (it already does: line 11 `a === 'codemie-codex'`).

### Patterns and Conventions

- **Agent metadata name as canonical identity**: `metadata.name` drives the registry key, the CLI binary name suffix (via `AgentCLI.setupProgram()` line 61–63 `programName = name.startsWith('codemie-') ? name : 'codemie-' + name`), and `CODEMIE_AGENT`. Currently metadata names are short (`claude`, `codex`) while wrapper binaries are long (`codemie-claude`, `codemie-codex`).
- **`agentMatchesAnalyticsFilter` pattern**: extended family matching already exists for codex. The fix should replicate this pattern for all agents that have both a short native name and a `codemie-` prefixed wrapper name.
- **Session file format**: plain JSON, written by `SessionStore.saveSession()`, read by `MetricsDataLoader.loadSession()`. Schema is `Session` interface in `src/agents/core/session/types.ts`.
- **CODEMIE_AGENT env var**: single environment variable that flows from `BaseAgentAdapter.run()` through the entire subprocess tree (hooks, proxy plugins, etc.). Changing it is a cross-cutting concern.
- **`ensureSessionFile` fallback**: used by `codemie-code` plugin as a last-resort session creator. It also reads `CODEMIE_AGENT`; once the env var is correct, it works automatically.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — covers the 5-layer plugin architecture; confirms the `CLI → Registry → Plugin` flow and the role of `BaseAgentAdapter`.
- `.ai-run/guides/testing/testing-patterns.md` — Vitest conventions; relevant for writing the required new tests.
- `.ai-run/guides/standards/code-quality.md` — TypeScript conventions (interfaces, explicit return types, no `any`).
- No guide specifically documents the session write pipeline or the `CODEMIE_AGENT` env var contract.

### Architectural Decisions

- The `BUILTIN_AGENT_NAME = 'codemie-code'` constant (exported from `src/agents/plugins/codemie-code.plugin.ts`) is the only agent whose stored `agentName` already uses the wrapper name convention. This was intentional because `codemie-code` is a standalone product, not a transparent wrapper around a third-party CLI.
- The `metadata.name` for `claude`, `codex`, `gemini`, `kimi`, `opencode` was chosen to match the underlying third-party CLI binary name. The short-name convention was a deliberate simplification; the wrapper name was not considered a session-attribution requirement at the time.
- The `AgentRegistry` uses `metadata.name` as its lookup key. Any approach that changes `CODEMIE_AGENT` without changing `metadata.name` must ensure `AgentRegistry.getAgent(CODEMIE_AGENT)` still resolves to the correct plugin (either by keeping the registry key as the short name, or by registering alias keys).

### Derived Conventions

- The pattern `name.startsWith('codemie-') ? name : 'codemie-' + name` in `AgentCLI.setupProgram()` shows a clear precedent: the CLI binary name IS always `codemie-<name>`. The `metadata.name` is the canonical short name used internally; the wrapper binary is `codemie-<short>`.
- Tests use `agentName: 'claude'` in all fixtures currently. Any test that constructs session fixtures needs to be updated to also test `codemie-claude` etc.

---

## 4. Testing Landscape

### Existing Coverage

- `src/cli/commands/analytics/__tests__/data-loader.test.ts` — tests `MetricsDataLoader.sessionMatchesFilter()` and `loadSessions()` with `agentName: 'claude'` hardcoded. Does NOT test any `codemie-` prefixed agent names.
- `src/cli/commands/analytics/cost/__tests__/codex-agent.test.ts` — tests `isCodexFamilyAgent()` and `agentMatchesAnalyticsFilter()` for codex family only.
- `src/cli/commands/analytics/__tests__/aggregator.test.ts` — tests aggregation; uses fixture data with short agent names.
- `src/cli/commands/analytics/__tests__/native-loader.test.ts` — tests native session synthesis; agent names are `claude`/`codex`.
- `src/cli/commands/analytics/sources/__tests__/sessions-source.test.ts` — tests native vs. external session filtering; `agentName: 'claude'` in fixtures.
- No existing test exercises `codemie-claude`, `codemie-gemini`, `codemie-kimi`, `codemie-opencode` as stored `agentName` values.

### Testing Framework and Patterns

- **Framework**: Vitest (see `package.json`, guide: `.ai-run/guides/testing/testing-patterns.md`).
- **Dynamic import mocking**: `vi.mock('../../data-loader.js', ...)` — used in `sessions-source.test.ts`.
- **Filesystem fixtures**: `mkdtempSync`/`writeFileSync`/`rmSync` — used in `data-loader.test.ts` for real session file I/O.
- **Pure unit tests**: `codex-agent.test.ts` calls functions directly with no mocks.
- Test utilities are co-located in `__tests__/` subdirectories within the feature module.

### Coverage Gaps

- No test verifies that `agentMatchesAnalyticsFilter('codemie-claude', 'claude')` returns the expected value (currently `false` — whether that should be `true` is a design decision).
- No test verifies that `agentMatchesAnalyticsFilter('claude', 'codemie-claude')` returns the expected value.
- No test uses `codemie-gemini`, `codemie-kimi`, `codemie-opencode` as `agentName` in any session fixture.
- No test verifies that `BaseAgentAdapter` writes the correct wrapper name into `CODEMIE_AGENT` (that code path is integration-level and has no dedicated unit tests in this module).
- No test covers `agentMatchesAnalyticsFilter` for the legacy `codemie_cli` (underscore) variant.

---

## 5. Configuration and Environment

### Environment Variables

- `CODEMIE_AGENT`: set by `BaseAgentAdapter.run()` (line 511 of `src/agents/core/BaseAgentAdapter.ts`); consumed by `hook.ts` (session creation, metrics sending), `logger.ts`, and proxy plugins. This is the central variable that needs to change.
- `CODEMIE_SESSION_ID`: the UUID session identifier; unchanged.
- `CODEMIE_PROVIDER`: provider name (e.g., `ai-run-sso`); unchanged.
- `CODEMIE_CLIENT_TYPE`: defaults to `this.metadata.ssoConfig?.clientType || 'codemie-cli'`; independent of agentName.
- `CODEMIE_AGENT` is also read in `hook.ts initializeLoggerContext()` (line 133) and `hook.ts initializeHookContext()` (line 1244) to initialize the logger's agent name for log formatting.

### Configuration Files

- `~/.codemie/sessions/<uuid>.json` — the session metadata file; `agentName` field is the focus of the fix.
- `~/.codemie/sessions/completed_<uuid>.json` — renamed form of the above after `SessionEnd`.
- No config file controls the `agentName` mapping; it derives entirely from `metadata.name` at runtime.

### Feature Flags and Deployment Concerns

- No feature flags exist for agent attribution.
- The analytics command reads session files directly from disk; no API or database migration is involved.
- Existing session files on disk with old short names (`claude`, `codex`, etc.) will NOT be retroactively updated. The fix only affects new sessions created after the change is deployed. Backward compatibility of the analytics filter is therefore important: `--agent claude` should still match sessions with stored name `claude` (pre-fix) as well as any new short-name sessions.
- The backend API (`sendSessionStartMetrics`, `sendSessionEndMetrics`) also receives `agentName`; changing the stored name changes what is sent to the server. This is a backend-facing impact that may require coordination.

---

## 6. Risk Indicators

- **`AgentRegistry.getAgent(CODEMIE_AGENT)` dependency**: `hook.ts` calls `AgentRegistry.getAgent(agentName)` at multiple points (`performIncrementalSync` line 318, `normalizeEventName` line 534, `sendSessionStartMetrics` line 831). If `CODEMIE_AGENT` is changed to `codemie-claude`, the registry lookup will return `undefined` because the registry key is `claude`. This would silently break session processing (incremental sync, hook normalization, MCP detection). **Critical path risk.** Any fix must either: (a) keep `metadata.name` as `claude` and derive the wrapper name separately for session storage, or (b) add registry aliases for `codemie-*` names.
- **Backend API receives `agentName`**: Both `sendSessionStartMetrics` and `sendSessionEndMetrics` pass `agentName` to the CodeMie API. Changing to wrapper names changes the API payload and may break backend analytics queries or dashboards that filter on short names. **Coordination required.**
- **`isCodexFamilyAgent()` dependency in native-loader and cost-enricher**: The cost enricher uses `isCodexFamilyAgent(agentName)` to select parsers. If sessions written by `codemie-codex` are stored as `codemie-codex`, `isCodexFamilyAgent()` already handles this (it checks `a === 'codemie-codex'`). No regression here.
- **Backward compatibility of existing session files**: Sessions already on disk use short names. The `--agent` filter must still match those. The safest approach is to make `agentMatchesAnalyticsFilter` treat `claude` and `codemie-claude` as the same family (bidirectional match).
- **`codemie_cli` legacy underscore variant**: The acceptance criteria requires matching `codemie_cli` (underscore). No existing code handles this normalization. This is an ad-hoc variant that needs explicit handling in the filter function.
- **No existing tests for wrapper agent names**: All test fixtures use short names. The test surface for the new names is zero, making regression risk high until covered.
- **`NATIVE_AGENTS` in native-loader is hardcoded to `['claude', 'codex']`**: Only Claude and Codex native sessions are discovered. Gemini, Kimi, and OpenCode native sessions are NOT discovered. This is a pre-existing limitation; the ticket focuses on CodeMie-tracked sessions, but it is worth noting in scope.
- **`Session.agentName` type comment**: `types.ts` line 115 comments `// 'claude', 'gemini'` — this is documentation debt, not a code bug, but should be updated.

---

## 7. Summary for Complexity Assessment

**Layers touched and file change surface:** The fix spans three distinct layers. The root cause is in the Agent Plugin layer (`src/agents/core/BaseAgentAdapter.ts`, one line: `CODEMIE_AGENT: this.metadata.name`). However, simply changing `this.metadata.name` to include the `codemie-` prefix would break the `AgentRegistry` lookup used in `src/cli/commands/hook.ts` at multiple call sites. The safest implementation path is to introduce a separate wrapper-name field (e.g., derive `codemie-${this.metadata.name}` at the `CODEMIE_AGENT` assignment site, while keeping `metadata.name` unchanged for registry lookups). The second change required is in the Analytics filter layer: `src/cli/commands/analytics/cost/codex-agent.ts` must have its `agentMatchesAnalyticsFilter` function extended to handle all seven canonical agent types bidirectionally (wrapper name ↔ short name). Total estimated file changes: 3–5 source files (`BaseAgentAdapter.ts`, `codex-agent.ts`, `types.ts` comment update, possibly `hook.ts` if the logger/registry call sites need guard updates).

**Technical novelty:** The pattern for family-based agent matching already exists (Codex family). The fix extends this established pattern to all agents. The tricky part is ensuring `AgentRegistry.getAgent()` continues to work after the env var change — this requires either a wrapper-name derivation at the assignment site (preferred) or registry aliasing. The derivation approach (`codemie-${name}` where name is the short plugin name) is straightforward and keeps `metadata.name` as the stable registry key. The `codemie_cli` legacy underscore variant (acceptance criteria item 7) is a special case with no obvious source in the current codebase — it may be a historical alias from before hyphens were standardized.

**Test coverage posture and key risks:** The affected area has moderate test coverage for existing behavior but zero coverage for the new agent name variants. Tests will need to be added for `codex-agent.ts` filter logic (covering all seven agent types), for the data-loader's filter behavior with wrapper names, and possibly for the `BaseAgentAdapter` env var assignment. The most significant risk is the `AgentRegistry.getAgent(CODEMIE_AGENT)` dependency in `hook.ts` — if the implementation naively changes the env var to the wrapper name, session processing will silently degrade (hooks will log a warning and skip processing, causing sessions to appear in analytics with no metrics data). Backend API impact (agentName in metrics API calls) may require server-side coordination and should be confirmed before deploying.
