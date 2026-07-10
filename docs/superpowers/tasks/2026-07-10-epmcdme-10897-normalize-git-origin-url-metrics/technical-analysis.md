# Technical Research

**Task**: metrics git remote url normalization analytics
**Generated**: 2026-07-10T00:00:00Z
**Research path**: filesystem

---

## 1. Original Context

Propagate normalized Git origin remote URL to metrics. Ensure metrics contain stable and privacy-safe repository identifier by sending normalized Git origin remote URL (instead of only repository name). CLI reads the remote URL for 'origin' from Git configuration, normalizes the remote URL into an <org>/<repo> form (no protocol, no host, no tokens), then sends this normalized value to metrics together with existing repository-related fields. If origin remote is missing or cannot be read, metrics emission continues without failing; repository URL field is omitted (or set to a safe empty value). Acceptance criteria: Metrics payload includes an additional field that contains the normalized repository identifier derived from Git remote origin. Normalization rules: git@gitbud.epam.com:epm-cdme/codemie.git -> epm-cdme/codemie; git@github.com:codemie-ai/codemie-code.git -> codemie-ai/codemie-code; Any embedded credentials/tokens in the remote URL are removed.

---

## 2. Codebase Findings

### Existing Implementations

The normalization function and the `repository` field already exist end-to-end. The task reduces to fixing one propagation gap and adding test coverage. No new normalization logic needs to be written.

**Normalization utility (core)**
- `src/utils/processes.ts` lines 397–407 — `detectGitRemoteRepo(cwd: string): Promise<string | undefined>`
  - Runs `git remote get-url origin` with a 5 s timeout via `child_process.execAsync`
  - Normalizes with regex `/[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/`
  - Handles SSH (`git@host:org/repo.git`), HTTPS (`https://host/org/repo.git`), and token-embedded HTTPS (`https://user:token@host/org/repo.git`)
  - Returns `org/repo` string or `undefined` on any failure; never throws
  - Sister function `detectGitBranch` follows the same pattern for the git branch

**Session type layer**
- `src/agents/core/session/types.ts` line 122 — `Session.repository?: string`
  - Documented as: "Resolved repository identifier: owner/repo from git remote, or parent/current fallback"
  - The field is optional; it is omitted when git remote is unavailable

**Metrics type layer**
- `src/providers/plugins/sso/session/processors/metrics/metrics-types.ts` line 14 — `MetricIdentity.repository: string` (required)
  - Present in both `SessionLifecycleAttributes` (session start/end) and `ToolUsageAttributes` (periodic sync)
  - Already typed as a required `string` in every metric payload

**Metrics emission layer**
- `src/providers/plugins/sso/session/processors/metrics/metrics-api-client.ts`
  - `MetricsSender.sendSessionStart` lines 330–456: resolves `repository = session.repository ?? extractRepository(workingDirectory)` (line 342)
  - `MetricsSender.sendSessionEnd` lines 469–557: same fallback pattern (line 481)
  - Both set `repository` on the `attributes` object and also emit it as the `X-CodeMie-Repository` HTTP header

**Metrics aggregation (tool-usage metrics)**
- `src/providers/plugins/sso/session/processors/metrics/metrics-aggregator.ts` line 239
  - `buildSessionAttributes`: `repository: session.repository ?? extractRepository(session.workingDirectory)`

**Metrics post-processor**
- `src/providers/plugins/sso/session/processors/metrics/metrics-post-processor.ts` line 36
  - `postProcessMetric` calls `truncateProjectPath(sanitized.attributes.repository)` unconditionally
  - `truncateProjectPath` was designed for filesystem paths; it takes the last two path segments
  - For an already-normalized `owner/repo` value it is a no-op (two forward-slash segments pass through unchanged on any platform)
  - This post-processor is only called for `codemie_cli_tool_usage_total`; session lifecycle metrics bypass it

**Session population paths — where `Session.repository` is set**

| File | Lines | Context |
|---|---|---|
| `src/agents/core/BaseAgentAdapter.ts` | 498–514 | Calls `detectGitRemoteRepo` at session start; sets `CODEMIE_REPOSITORY` env var before spawning agent subprocess |
| `src/cli/commands/hook.ts` | 644–772 (`createSessionRecord`) | Calls `detectGitRemoteRepo`, stores result as `session.repository` in the persisted session JSON file |
| `src/cli/commands/hook.ts` | 783–916 (`sendSessionStartMetrics`) | Makes an independent second call to `detectGitRemoteRepo` for the session start lifecycle metric |
| `src/cli/commands/hook.ts` | 1056–1162 (`sendSessionEndMetrics`) | Reads persisted `session.repository` from the stored session JSON; does not re-detect |
| `src/agents/core/session/ensure-session.ts` | 35–46 | Reads `CODEMIE_REPOSITORY` env var first; falls back to `detectGitRemoteRepo` only when absent or `'unknown'` |
| `src/telemetry/runtime/DesktopTelemetryRuntime.ts` | 110–138 | Calls `detectGitRemoteRepo` and sets `repository: repository || undefined` on the new `Session` — but does NOT forward this to `MetricsSender` (the gap) |

**Filesystem fallback utility**
- `src/utils/paths.ts` lines 397–410 — `extractRepository(workingDirectory)`
  - Used when `session.repository` is `undefined`; returns `parent/current` from the last two filesystem path segments
  - Has a special case for Claude Desktop sandbox paths (returns `'Claude Desktop'`)
  - Fully tested in `src/utils/__tests__/paths.test.ts`

**Skills metrics path (already correct)**
- `src/cli/commands/skills/lib/skills-metrics.ts` line 176 — calls `detectGitRemoteRepo` directly and sends `repository` in the skills events POST body and `X-CodeMie-Repository` header

### Architecture and Layers Affected

| Layer | Component | Files |
|---|---|---|
| Utils | Git detection, URL normalization, filesystem fallback | `src/utils/processes.ts`, `src/utils/paths.ts` |
| Session | Session type, session store, session lifecycle | `src/agents/core/session/types.ts`, `src/agents/core/session/SessionStore.ts`, `src/agents/core/session/ensure-session.ts` |
| CLI | Hook command — session start/end event handlers | `src/cli/commands/hook.ts` |
| Agent Core | BaseAgentAdapter — env var propagation | `src/agents/core/BaseAgentAdapter.ts` |
| Telemetry | Desktop telemetry runtime | `src/telemetry/runtime/DesktopTelemetryRuntime.ts` |
| Metrics (SSO plugin) | Aggregation, post-processing, transport, types | `src/providers/plugins/sso/session/processors/metrics/` |

The task is confined to the **Utils**, **Session**, **CLI hook**, and **Telemetry** layers. The metrics processor internals (`metrics-aggregator`, `metrics-api-client`, `metrics-types`) already implement the `repository` field correctly and require no changes.

### Integration Points

**Internal dependencies of the metrics domain:**
- `src/utils/processes.ts` (`detectGitRemoteRepo`, `detectGitBranch`) — imported in `BaseAgentAdapter.ts`, `hook.ts`, `ensure-session.ts`, `DesktopTelemetryRuntime.ts`, `skills-metrics.ts`
- `src/utils/paths.ts` (`extractRepository`) — imported in `metrics-api-client.ts`, `metrics-aggregator.ts`
- `CODEMIE_REPOSITORY` env var — the propagation channel from `BaseAgentAdapter` to all subprocess-side consumers (`ensure-session.ts`, `header-injection.plugin.ts`)

**HTTP boundary:**
- `POST /v1/metrics` — JSON body with `metric.attributes.repository`; also `X-CodeMie-Repository` request header
- `POST /v1/skills/events` — same pattern for skills metrics

**The single production gap identified:**
`src/telemetry/runtime/DesktopTelemetryRuntime.ts` calls `detectGitRemoteRepo` and populates `session.repository` correctly, but the `sendSessionStartMetric` and `sendSessionEndMetric` methods do not forward `session.repository` to `MetricsSender`. The calls fall back to `extractRepository(workingDirectory)` even when the git-derived value is available on the `Session` object.

### Patterns and Conventions

- **Guard pattern**: all `detectGitRemoteRepo` call sites are wrapped in `try/catch` or use the `undefined` return; a missing remote never throws into the metrics pipeline
- **Fallback chain**: `session.repository ?? extractRepository(workingDirectory)` — git remote wins; filesystem derivation is the last resort
- **Env var propagation**: `CODEMIE_REPOSITORY` is set by `BaseAgentAdapter` and read by `ensure-session.ts` to prevent divergence between the proxy and the hook paths
- **Conditional spread**: `...(remoteRepository && { repository: remoteRepository })` — the field is omitted from stored objects when `undefined`; never set to empty string
- **Session re-entry**: when `SessionStart` fires for an already-active session (e.g., after `/compact`), `session.repository` is preserved from the first detection and not overwritten

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — Defines the 5-layer architecture (CLI → Registry → Plugin → Core → Utils). The normalization function must remain in the Utils layer; all callers are in CLI or Core layers. The `src/analytics/` directory exists as a separate analytics seam but metrics live under `src/providers/plugins/sso/session/processors/metrics/`.
- `.ai-run/guides/security/security-practices.md` — The "no protocol, no host, no tokens" normalization requirement maps directly to the `sanitizeValue()`/`sanitizeLogArgs()` privacy pattern defined here. The guide's pre-commit secret scanner targets `Bearer`, `sk-ant-`, and similar token patterns — the same token classes that appear in git remote URLs with embedded credentials.
- `docs/SPEC-mcp-session-metrics.md` — Template spec for extending session metrics payloads. Shows the exact pattern for adding optional fields to `SessionLifecycleAttributes`. Its security section explicitly states: "Don't expose URLs — Only capture server names, not URLs" and "Don't expose tokens/secrets." Directly models the privacy contract for this task.
- `docs/superpowers/plans/2026-06-19-analytics-source-seam.md` — Analytics pipeline context for the `AnalyticsSource` seam. Not directly about git URL normalization but provides background on how session data flows to analytics reports.

### Architectural Decisions

- **Single source of truth for repository identifier** (`ensure-session.ts:31–33`): An inline comment records the decision explicitly: "Prefer values already resolved by BaseAgentAdapter (set in env before spawning the agent). Independent re-detection can diverge from the proxy's CODEMIE_REPOSITORY value, causing CLI_SESSION_TOTAL and CLI_LLM_USAGE_TOTAL to land in different ES repository buckets." This decision means `CODEMIE_REPOSITORY` is the canonical propagation channel.
- **`session.repository` set once at first SessionStart** (`hook.ts:678–722`): On session re-entry (e.g., after `/compact`), the existing `session.repository` is preserved; only `correlation` and `gitBranch` are refreshed. Repository identity is fixed for the lifetime of a session.
- **`tool_counts` field banned at type level** (`metrics-types.ts:96–97`): Documents the pattern for retiring fields — they are set to `never` in TypeScript to prevent re-introduction. Relevant if the task adds a new field that must eventually be retired.
- **Tool-usage metrics post-processed; session lifecycle metrics are not**: `postProcessMetric` (which calls `truncateProjectPath`) is only invoked in `aggregateDeltas` — the periodic sync path for `codemie_cli_tool_usage_total`. Session start/end lifecycle metrics bypass this sanitization step.

### Derived Conventions

- New optional fields on `Session` use `?: string` and conditional spread (`...(value && { field: value })`) rather than `field: undefined`
- Git operations that can fail (no git, no remote) always return `undefined` rather than throwing; the caller uses a `??` fallback
- Metric payload types extend `MetricIdentity` and always carry `repository: string` (required); the `undefined`-to-fallback resolution happens before payload construction

---

## 4. Testing Landscape

### Existing Coverage

- `src/utils/__tests__/paths.test.ts` — Comprehensive tests for `extractRepository` (the filesystem fallback), including Desktop sandbox detection. Does not touch `detectGitRemoteRepo`.
- `src/utils/__tests__/processes.test.ts` — Tests npm utilities (`installGlobal`, `commandExists`, `getCommandPath`). **`detectGitRemoteRepo` and `detectGitBranch` are entirely absent.**
- `src/cli/commands/skills/lib/__tests__/skills-metrics.test.ts` — Mocks `detectGitRemoteRepo` via `vi.mock('@/utils/processes.js')` with `mockResolvedValue('codemie-ai/codemie-code')`; asserts `body.repository` and `X-CodeMie-Repository` header are set; verifies both are absent when mock returns `undefined`. This is the only test that asserts the end-to-end repository-in-metrics contract.
- `src/agents/core/__tests__/BaseAgentAdapter.test.ts` — Mocks `detectGitRemoteRepo` to always return `null`; does not assert `CODEMIE_REPOSITORY` env var value with a real normalized URL.
- `tests/integration/metrics/metrics-post-processing.test.ts` — Creates a session with no `repository` field; asserts `metric.attributes.repository === 'codemie-ai/codemie-code'` via the filesystem `extractRepository` fallback. Does not exercise the `session.repository` primary path.
- `tests/integration/session/metrics-processor.test.ts` — Exercises the full sync pipeline with fixture files; no assertions on `repository` value.

### Testing Framework and Patterns

- **Framework**: Vitest with three projects: `unit` (`src/**/*.test.ts`), `cli` (`tests/integration/**/*.test.ts` excluding agent-*), `agent` (real-network integration tests)
- **Module mocking**: `vi.mock('@/utils/processes.js', () => ({ detectGitRemoteRepo: vi.fn(), ... }))` with named mock spies; alias `@/` maps to `src/`
- **Dynamic isolation**: `vi.resetModules()` + `vi.doMock()` + `await import(...)` for per-test module fresh instances
- **No BDD conventions**: standard `describe/it/expect` throughout
- **Mock factory pattern**: `vi.mock()` with a factory function returning stub objects is the established pattern for all `processes.ts` consumers

### Coverage Gaps

1. **`detectGitRemoteRepo` normalization logic** — No unit tests exist for the regex behavior against SSH URLs, HTTPS URLs, URLs without `.git` suffix, self-hosted GitLab URLs, or token-embedded HTTPS URLs. The acceptance criteria examples (`git@gitbud.epam.com:epm-cdme/codemie.git`, embedded credentials) are not validated by any test.
2. **`session.repository` primary path in `metrics-aggregator`** — The integration test for `metrics-post-processing` only exercises the `extractRepository` fallback. No test has a session with `repository` pre-set from a git remote.
3. **`ensure-session.ts` env var precedence** — No test file exists for `ensure-session.ts`. The three scenarios (env var present, env var absent, `detectGitRemoteRepo` returns undefined) are uncovered.
4. **`DesktopTelemetryRuntime` repository forwarding** — No test verifies that `session.repository` from the Desktop path reaches the metrics payload.
5. **Privacy safety regression** — No test validates that `https://ghp_token@github.com/org/repo.git` normalizes to `org/repo` and does not include the token in the output.
6. **`hook.ts` session start repository storage** — The `createSessionRecord` and `sendSessionStartMetrics` paths are not unit tested for repository field propagation.

---

## 5. Configuration and Environment

### Environment Variables

| Variable | Set by | Read by | Purpose |
|---|---|---|---|
| `CODEMIE_REPOSITORY` | `BaseAgentAdapter.run()` line 513 | `ensure-session.ts`, `header-injection.plugin.ts` | Canonical normalized `owner/repo` or filesystem fallback; the single-assignment source for all subprocess consumers |
| `CODEMIE_GIT_BRANCH` | `BaseAgentAdapter.run()` line 514 | `ensure-session.ts`, `buildProxyConfig()` | Git branch at session start |
| `CODEMIE_METRICS_DISABLED` | Operator-set | `session-config.ts` | Value `'1'` disables all metrics emission; the only runtime toggle for the entire metrics pipeline |
| `CODEMIE_SESSION_ID` | `BaseAgentAdapter.run()` | `hook.ts`, `ensure-session.ts`, metrics processor | Session UUID |
| `CODEMIE_PROVIDER` | Profile config, `exportEnvVars()` | `session-config.ts` | Must be `ai-run-sso` for metrics to be sent |
| `CODEMIE_CLI_VERSION` | Build-time injection | `metrics-api-client.ts` line 57 | Sent as `agent_version` in every metric payload |
| `CODEMIE_SYNC_API_URL` | Profile or SSO config | `hook.ts` line 790 | Overrides base API URL for metrics posting |

No `.env.example` or `.env` files exist in the repository.

### Configuration Files

- `.codemie/codemie-cli.config.json` — Project-local CLI config (active profile, provider, `codeMieUrl`, model tiers, assistants). No metrics or git remote configuration.
- `src/agents/core/session/session-config.ts` — Runtime metrics config object `METRICS_CONFIG`: whether metrics are enabled per provider, retry backoff delays, `excludeErrorsFromTools` list. No feature-flag registry beyond `CODEMIE_METRICS_DISABLED`.

### Feature Flags and Deployment Concerns

- `CODEMIE_METRICS_DISABLED=1` is the only runtime toggle; no feature-flag infrastructure exists for this domain.
- The normalization function (`detectGitRemoteRepo`) hard-codes the remote name `origin`. If a repository uses a different upstream remote name, the function returns `undefined` and the fallback to `extractRepository` applies. No configuration override is available for the remote name.
- Token leakage via `CODEMIE_REPOSITORY` env var: the env var is set before the agent subprocess is spawned and is therefore visible to the agent runtime. The value is already normalized (no protocol, no host, no token) by the time it is written to the env, so no leakage occurs.

---

## 6. Risk Indicators

- **No unit tests for `detectGitRemoteRepo` normalization regex** — the core behavior described in the acceptance criteria (SSH URLs, HTTPS URLs, embedded-token stripping, missing remote) has zero test coverage in `src/utils/__tests__/processes.test.ts`. Any regex bug would go undetected.
- **Privacy safety not regression-tested** — There is no explicit test that a token-embedded URL (`https://ghp_token@github.com/org/repo.git`) produces `org/repo` rather than a token-bearing output. This is a security-sensitive gap for the stated privacy goal.
- **`DesktopTelemetryRuntime` forwarding gap** (`src/telemetry/runtime/DesktopTelemetryRuntime.ts` lines 241–271 and 288–301) — `session.repository` is set on the `Session` object but is not passed to `MetricsSender.sendSessionStart` or `sendSessionEnd`. The Desktop path always falls back to `extractRepository(workingDirectory)`. This is the only production code change required.
- **Redundant double-call to `detectGitRemoteRepo` in `hook.ts`** — `createSessionRecord` (line 668) and `sendSessionStartMetrics` (line 808) each independently call `detectGitRemoteRepo` in the same session start flow. In the narrow window between calls, a git remote reconfiguration could cause the stored `session.repository` and the emitted lifecycle metric to diverge. The task's acceptance criteria do not require fixing this but it is pre-existing debt.
- **GitLab multi-level subgroup paths silently truncated** — For `git@gitlab.com:group/subgroup/repo.git`, the regex returns `subgroup/repo`, dropping the top-level group. No test covers this case. For the named examples in the acceptance criteria (`epm-cdme/codemie.git`, `codemie-ai/codemie-code.git`) this is not a problem, but it is an undocumented limitation.
- **`truncateProjectPath` intent mismatch** — `metrics-post-processor.ts` applies `truncateProjectPath` (a filesystem path helper) to `metric.attributes.repository` for tool-usage metrics. For an already-normalized `owner/repo` value it is a no-op, but for an unexpectedly longer value (e.g., `gitlab.com/group/repo` if normalization is bypassed) it would silently drop the `gitlab.com/group` prefix. The function is safe in the expected code paths but its placement introduces a silent correctness hazard.
- **`ensure-session.ts` has no test file** — the env-var-first precedence logic and fallback detection are unverified. This is pre-existing debt but becomes higher risk if new callers are added.
- **Session lifecycle metrics bypass `postProcessMetric`** — `codemie_cli_session_total` (start/end) sends `repository` without passing through `truncateProjectPath`, while `codemie_cli_tool_usage_total` (periodic sync) does pass through it. The inconsistency is currently harmless but could produce different `repository` values for the same session across metric names if the two paths ever diverge.

---

## 7. Summary for Complexity Assessment

The implementation surface for this task is **smaller than it first appears**. The normalization function (`detectGitRemoteRepo` in `src/utils/processes.ts`) and the `repository` field in both the `Session` type and all metric payload types already exist and work correctly. The full pipeline — git detection → session storage → metric aggregation → HTTP transport — is in place for the CLI hook path (`hook.ts`) and the agent adapter path (`BaseAgentAdapter.ts`). The only production code change required is in `src/telemetry/runtime/DesktopTelemetryRuntime.ts`, where `session.repository` is populated but not forwarded in the two `MetricsSender` calls (`sendSessionStartMetric` lines 241–271, `sendSessionEndMetric` lines 288–301). The fix is a single-line conditional spread per call, following the established `...(session.repository && { repository: session.repository })` pattern already used in `hook.ts`. Total production file changes: 1 file, 2 lines.

The meaningful work in this task is **test coverage**. The acceptance criteria's normalization examples are not validated by any existing test. `src/utils/__tests__/processes.test.ts` requires new unit tests for `detectGitRemoteRepo` covering the four URL forms in the acceptance criteria plus the `undefined` fallback on missing remote. Integration tests in `tests/integration/metrics/metrics-post-processing.test.ts` need a case with `session.repository` pre-set to confirm the primary path wins over `extractRepository`. A privacy-safety regression test for token-embedded URLs is also absent. These tests do not require architectural invention — the mocking patterns are established (`vi.mock('@/utils/processes.js', ...)`), the assertion targets are known (`metric.attributes.repository`), and analogous tests exist in `skills-metrics.test.ts`.

The primary **risk factors** are: (1) the privacy-safety gap — no regression test guards against a future regex change that re-introduces token leakage in URLs with embedded credentials; (2) the `DesktopTelemetryRuntime` fix is a 2-line change but verifying it requires either an integration test for the Desktop path (no such test exists today) or careful manual verification; (3) the pre-existing double-call redundancy in `hook.ts` and the `truncateProjectPath` intent mismatch are not blocking but may require a decision from the implementer about whether to scope-include them. Overall complexity is low-to-medium: 1 production file change, 3–4 test files to extend or create, all following established patterns, no new dependencies, no schema migrations, no API contract changes.
