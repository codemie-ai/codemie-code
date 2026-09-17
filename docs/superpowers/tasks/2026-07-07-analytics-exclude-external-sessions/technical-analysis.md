# Technical Research

**Task**: analytics session-ownership session-origin claude codex native-loader
**Generated**: 2026-07-07
**Research path**: filesystem

---

## 1. Original Context

Jira ticket EPMCDME-13367 — "Fix analytics command to exclude non-CodeMie-owned external sessions"

Description: The main fix for resuming non-CodeMie-owned sessions was handled in the parent
issue EPMCDME-12992 (already merged to main via PR #403 "feat(agents): restrict session
ingestion to CodeMie-owned sessions", commit 3015cd2). That PR introduced
src/agents/core/session/session-ownership.ts (scanSessionsForClaudeId) and
src/agents/core/session/session-origin-audit.ts, and modified src/agents/core/AgentCLI.ts,
src/agents/plugins/claude/claude.plugin.ts, src/agents/plugins/codex/codex.plugin.ts, and their
conversations-processors to gate RESUME on session ownership.

However, the `codemie analytics` command still scans and reports ALL detected local sessions
(Claude, Codex, etc.) without filtering out sessions that were not created by CodeMie. This
sub-task covers the remaining analytics-specific gap: CodeMie Analytics must include only
CodeMie-owned sessions and must not expose unrelated external session data.

Acceptance criteria from the ticket:
- The analytics command does not include sessions created outside CodeMie.
- Session filtering is based on CodeMie ownership/origin validation before analytics
  aggregation/output.
- Non-CodeMie-owned sessions under local Claude session directories are ignored by analytics
  processing.
- Analytics output remains correct for valid CodeMie-owned sessions.
- Regression coverage confirms analytics does not scrape all sessions blindly and excludes
  external sessions.

Research goal: understand exactly how the analytics pipeline currently discovers/loads sessions
(native-loader.ts, sessions-source.ts, data-loader.ts, aggregator.ts, per-plugin
conversations-processor files under src/cli/commands/analytics/), how ownership validation
works today (session-ownership.ts, session-origin-audit.ts, AgentCLI.ts resume-path usage,
types.ts additions from PR #403), and identify the precise integration point(s) where an
ownership/origin check should be applied to analytics session discovery for each agent plugin
(Claude, Codex, and any others with local session files e.g. Gemini/OpenCode/Kimi). Also note
existing test patterns for analytics loaders and for session-ownership so a regression test can
follow established conventions.

---

## 2. Codebase Findings

### Existing Implementations

- `src/cli/commands/analytics/native-loader.ts` — discovers untracked native Claude/Codex logs
  and synthesizes `RawSessionData`. **This is the defect location.** `NATIVE_AGENTS = ['claude',
  'codex']` — hardcoded, and share one discovery loop. `hasOwnershipMarker(filePath)` (from
  `NativeLoaderDeps`) is already computed at **line ~518** but only used to *tag* the session:
  `if (!deps.hasOwnershipMarker(descriptor.filePath) && raw.startEvent) { raw.startEvent.data.provider
  = 'native-external'; }` — the session is still unconditionally pushed to the output array at
  line 521 (`out.push(raw)`) and flows downstream unfiltered.
  Key exports: `loadNativeSessions(filter?: AnalyticsFilter, deps: NativeLoaderDeps =
  realNativeDeps): Promise<RawSessionData[]>`, `synthesizeRawSession(agentName, descriptor,
  parsed)`, `synthesizeCodexRawSession(...)`, interface `NativeLoaderDeps` (`hasOwnershipMarker`,
  `trackedLogPaths`, `discover`, `parse`, `realPath`), `realNativeDeps` (fs-backed impl).
  `realNativeDeps.hasOwnershipMarker` (lines ~135-199) implements its own
  `buildOwnershipIndex()`: a cached `Set<realpath>` (`ownershipIndexCache`, process-lifetime)
  built from correlation `agentSessionFile` real-paths (from tracked-session metadata files) +
  `transcriptPath` values from sidecar `-codemie-marker.json` files (fast path), falling back to
  a **bounded 4KB / 10-line** scan of the transcript for a `codemie_session_start` JSON line
  (slow path, per CR-002 fix — never a full-file read).
- `src/cli/commands/analytics/sources/sessions-source.ts` — `SessionsSource.load()` builds
  tracked sessions via `MetricsDataLoader`, then (unless `opts.scanNative === false`) dynamically
  imports `loadNativeSessions` and merges filtered natives in. This is the top of the discovery
  pipeline that `analytics/index.ts` calls, and an alternative integration point for a
  post-hoc `.filter(...)` if exclusion is applied outside `native-loader.ts` itself.
- `src/cli/commands/analytics/sources/types.ts` — `AnalyticsSource.load(opts:
  SourceLoadOptions): Promise<SourceResult>`; `SourceLoadOptions { filter, scanNative? }`;
  `SourceResult { rawSessions, cost? }`.
- `src/cli/commands/analytics/data-loader.ts` — `MetricsDataLoader.loadSessions(filter?)` reads
  `~/.codemie/sessions/*.json` (tracked, CodeMie-owned by construction — no ownership check
  needed here). `sessionMatchesFilter` is exposed `public` specifically so native/untracked
  sessions can be run through the same filter logic.
- `src/cli/commands/analytics/aggregator.ts` (~line 405-410) — `AnalyticsAggregator` builds
  `SessionAnalytics` from `RawSessionData`, copying `provider: startEvent.data.provider` through
  with **no ownership-based exclusion**. Only existing filter is an empty-deltas exclusion
  (`aggregate()` lines 43-45, `keepSessionIds`).
- `src/cli/commands/analytics/formatter.ts` (lines 156-166) — `displaySession()` only
  cosmetically flags `provider === 'native-external'` with a yellow "external ⚠ not
  CodeMie-managed" label; does not exclude the session from any totals/output. This branch
  becomes dead code (or should be repurposed behind a debug/opt-in flag) once exclusion happens
  upstream.
- `src/cli/commands/analytics/types.ts` — `SessionAnalytics.provider: string` (values include
  `'native' | 'native-external' | 'claude' | 'codex' | ...`); `AnalyticsFilter`;
  `AnalyticsOptions.scanNative?: boolean` (backs the existing `--no-scan-native` CLI flag — a
  coarse on/off switch, distinct from the fine-grained per-session ownership filter this ticket
  needs).
- `src/cli/commands/analytics/index.ts` — `createAnalyticsCommand()` wires `--no-scan-native` →
  `SourceLoadOptions.scanNative`; `runAnalytics()` calls `source.load(...)`.
- `src/agents/core/session/session-ownership.ts` — `scanSessionsForClaudeId(claudeSessionId:
  string, sessionsDir?: string): boolean` scans `~/.codemie/sessions/*.json` (excluding
  `_metrics.json` via `.endsWith('_metrics.json')`, per CR-R-002 fix — not `.includes`) for a
  record whose `correlation.agentSessionId === claudeSessionId`. Despite the "Claude" naming it
  is generically usable (keys off an arbitrary agent session id). **Not currently reused by
  native-loader.ts**, which reimplements a parallel ownership-index scan inline — a drift risk
  between the RESUME-path ownership check and the analytics-path ownership check.
- `src/agents/core/session/session-origin-audit.ts` — `appendAuditEvent(event: AuditEventName,
  data, logsDir?)` writes JSONL to `~/.codemie/logs/session-origin-audit.jsonl`;
  `AuditEventName = 'transcript_marker_written' | 'resume_blocked' | 'resume_external_confirmed'`
  (would need a new value, e.g. `'analytics_external_excluded'`, if analytics adopts audit
  logging for exclusions). `appendTranscriptMarker(transcriptPath, codemieSessionId,
  codemieAgent)` writes the sidecar marker `~/.codemie/sessions/{id}-codemie-marker.json` (moved
  off the live transcript per CR-006/CR-007 to avoid `appendFileSync` races) plus a best-effort
  `codemie_session_start` transcript line for legacy compat. Called from `src/cli/commands/
  hook.ts` (~lines 706, 747-751) at session-start — this is what makes `hasOwnershipMarker`
  able to detect ownership later.
- `src/agents/core/AgentCLI.ts` (~lines 308-378) — reference RESUME-gating integration pattern:
  builds `resumeId`, calls `adapter.resolveResumeOwnership({resumeId, cwd, env})`, computes
  `isExternal = ownership?.supported === true && ownership.owned === false`, prompts
  (`promptExternalResume`), and audits via `appendAuditEvent('resume_blocked' |
  'resume_external_confirmed', ...)` (dynamically imported). Fails open when the adapter does
  not implement the optional capability.
- `src/agents/plugins/claude/claude.plugin.ts` (lines 325-340) — implements
  `resolveResumeOwnership()` via dynamic import of `scanSessionsForClaudeId`.
- `src/agents/plugins/codex/codex.plugin.ts` — implements `extractNativeResumeId(args)` but
  does **not** implement `resolveResumeOwnership` — a gap on the RESUME path. This does not
  block the analytics fix, however, because `native-loader.ts`'s `hasOwnershipMarker` is
  agent-agnostic (keyed on file path/content, not plugin-specific format) and already covers
  both Claude and Codex through the single shared loop.
- `src/agents/core/types.ts` (lines ~658-693) — `ResumeOwnershipInput { resumeId, cwd, env }`;
  `ResumeOwnershipResult { supported, owned?, fallbackResumeCommand?, auditData? }`;
  `AgentAdapter.resolveResumeOwnership?(...)` and `AgentAdapter.extractNativeResumeId?(...)` are
  both optional capabilities. Analytics has **no equivalent typed contract** yet — it only has
  the untyped boolean `hasOwnershipMarker`.
- `src/agents/core/session/discovery-types.ts` — `SessionDescriptor` has no ownership field;
  ownership is resolved out-of-band via marker files, not encoded in the descriptor itself.
- `src/cli/commands/analytics/cost/codex-agent.ts` — `isCodexFamilyAgent`,
  `agentMatchesAnalyticsFilter` — reusable per-plugin dispatch pattern already used by both
  `native-loader.ts` and `data-loader.ts`.
- **Scope confirmation**: Gemini (`src/agents/plugins/gemini/...`, `dataPaths.home = '.gemini'`),
  OpenCode (`src/agents/plugins/opencode/opencode.paths.ts`), and Kimi
  (`src/agents/plugins/kimi/...`, `dataPaths.home = '.kimi-code'`) each have their own
  `discoverSessions()` session-adapter implementations, but **none of them are included in
  `NATIVE_AGENTS` today** — analytics does not scan their native session files at all
  (neither includes nor needs to exclude them). The ticket's "e.g. Gemini/OpenCode/Kimi" phrasing
  in feature_area is therefore not an active concern for this fix; only Claude and Codex have
  native sessions flowing through `native-loader.ts` today.

### Architecture and Layers Affected

- CLI command layer: `src/cli/commands/analytics/index.ts` (flag parsing, dispatch)
- Analytics source layer: `src/cli/commands/analytics/sources/sessions-source.ts`,
  `otel-source.ts` (implements `AnalyticsSource`)
- Session discovery layer: `native-loader.ts` (native/untracked discovery + synthesis, **defect
  location**) and `data-loader.ts` (tracked `~/.codemie` session loading, unaffected)
- Session ownership/origin layer (agents core): `src/agents/core/session/session-ownership.ts`,
  `session-origin-audit.ts` — reusable primitives, not yet consumed by analytics
- Agent adapter layer: `src/agents/plugins/claude/claude.plugin.ts`,
  `src/agents/plugins/codex/codex.plugin.ts`
- Orchestration/CLI-run layer: `src/agents/core/AgentCLI.ts` (reference RESUME-gating consumer,
  not itself in scope for this ticket)
- Aggregation/presentation layer: `aggregator.ts`, `formatter.ts`, `exporter.ts`,
  `report/payload-builder.ts`

### Integration Points

- `src/cli/commands/analytics/native-loader.ts:518-521` — primary fix point. Change the
  tag-only branch to skip/`continue` (exclude from `out`) when `!deps.hasOwnershipMarker(...)`,
  for both Claude and Codex since they share the loop. Optionally gate behind a new
  default-true option with an opt-in escape hatch (e.g. `--include-external`) if diagnostic
  visibility into excluded sessions is still desired.
- `src/cli/commands/analytics/native-loader.ts:135-199` (`realNativeDeps.hasOwnershipMarker`) —
  candidate to reconcile with `session-ownership.ts`'s `scanSessionsForClaudeId` logic for
  consistency between the RESUME-path and analytics-path ownership checks, rather than
  maintaining two parallel implementations.
- `src/cli/commands/analytics/sources/sessions-source.ts:19-23` — alternative/secondary
  integration point: filter the merged `natives` array here if exclusion is applied post-hoc
  rather than inside `native-loader.ts`.
- `src/cli/commands/analytics/types.ts:233-251` (`AnalyticsOptions`) — would need a new option
  (e.g. `includeExternal?: boolean`) mirrored in `index.ts:createAnalyticsCommand()` if an
  explicit opt-in escape hatch is desired.
- `src/cli/commands/analytics/formatter.ts:162-166` — current display-only `'native-external'`
  branch should be retired or repurposed for a debug-only mode once exclusion happens upstream.
- No plugin-specific integration point is needed for Claude/Codex today — `NATIVE_AGENTS`
  covers both through the single generic check. Gemini/OpenCode/Kimi are confirmed out of scope
  since they are not in `NATIVE_AGENTS` and analytics does not discover their native sessions at
  all currently.

### Patterns and Conventions

- **RESUME-gating pattern (reference)**: adapter exposes an optional capability
  (`resolveResumeOwnership`) → orchestrator calls it, interprets `{supported, owned}`, and only
  acts when the adapter opts in; plugins without the capability fail open (no-op). The
  analytics fix should mirror the "opt-in exclusion" spirit but does not need a new adapter
  capability since `hasOwnershipMarker` is already agent-agnostic.
- **Dependency-injection boundary for testability**: `NativeLoaderDeps` interface isolates
  fs/registry calls; tests inject fakes (`hasOwnershipMarker: () => boolean`) without touching
  disk. Any new filtering logic should extend this same seam.
- **Index-then-fallback ownership check**: fast path via cached realpath `Set`, slow path via
  bounded transcript scan for legacy sessions — agent-agnostic, reused for both Claude and
  Codex.
- **Tag-not-filter anti-pattern (current defect)**: labeling instead of excluding is exactly
  what this ticket must fix.
- **Non-fatal, best-effort audit/marker writes**: all fs operations in `session-origin-audit.ts`
  swallow errors and never break the primary flow; any new audit event should follow this
  convention.
- **Dynamic `import()` for optional/heavy modules**: `AgentCLI.ts`, `claude.plugin.ts`, and
  `sessions-source.ts` all lazy-import session-ownership/native-loader modules only when the
  code path is actually hit — new ownership-check wiring in analytics should follow the same
  convention.
- **Filter composition pattern**: `MetricsDataLoader.sessionMatchesFilter` is exposed `public`
  so untracked (native) sessions can be run through the same filter logic as tracked sessions —
  a similarly exported/reusable ownership-check function is the idiomatic shape for this fix.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — plugin-based 5-layer architecture (CLI →
  Registry → Plugin → Core → Utils); documents `src/agents/core/session/` as the session
  adapter layer, meaning new session-domain logic belongs there, agent-specific specifics stay
  in the plugin layer.
- `.ai-run/guides/integration/external-integrations.md` — documents the Session Analytics Flow
  (`onSessionEnd` hook → JSONL deltas → `SessionSyncer` → `v1/metrics`); background for what
  "excluding" a session from analytics affects downstream.
- `.ai-run/guides/testing/testing-patterns.md` — mandates dynamic-import mocking for Vitest
  (static imports bypass `vi.spyOn`), `vi.restoreAllMocks()` in `afterEach` — directly
  applicable to any new test for this fix.
- `.ai-run/guides/standards/code-quality.md` — naming/file-size/no-`console.log` conventions
  applicable to the native-loader.ts change.
- No guide specifically names "session-ownership" or "analytics origin exclusion" as a topic;
  conventions below are derived from code and prior review artifacts.

### Architectural Decisions

- `docs/superpowers/specs/2026-07-01-EPMCDME-12992-session-origin-validation-design.md` —
  **the original design explicitly decided**: "No sessions are hidden — all are surfaced,
  external ones are clearly marked." This is precisely the decision EPMCDME-13367 must reverse
  for the analytics command specifically (the RESUME-path UX of informing users about external
  sessions can remain unchanged; only analytics aggregation/output needs to exclude them).
- `docs/superpowers/reviews/2026-07-01-EPMCDME-12992/code-review-final.json` (CR-002) — bounded
  4KB/10-line transcript scan fix (avoid OOM on huge transcripts) — must be preserved in any
  refactor of `hasOwnershipMarker`.
- Same review (CR-003) — index-first ownership check must precede the transcript-marker scan,
  to avoid false-positive "external" labeling of re-entered CodeMie sessions — must be
  preserved if `buildOwnershipIndex()` logic is touched.
- Same review (CR-006/CR-007) — ownership marker moved to a sidecar file instead of appending
  to the live transcript, to avoid `appendFileSync` races.
- `docs/superpowers/specs/2026-07-06-generic-resume-ownership-validation-design.md` (commit
  dffcddc) — made resume ownership validation a generic, optional adapter capability; fail-open
  when unsupported; preserves slug-based resume IDs. Relevant context, not directly touched by
  this ticket.
- `docs/superpowers/reviews/2026-07-01-EPMCDME-12992-2/code-review-final.json` (CR-R-002) —
  `_metrics.json` filtering must use `.endsWith('_metrics.json')`, not `.includes('_metrics')`,
  for consistency between `native-loader.ts` and `session-ownership.ts`.
- `docs/superpowers/tasks/2026-07-01-epmcdme-12992-session-origin-validation/qa-report.md` — QA
  note: lint required `\p{Cc}/gu` control-char stripping instead of an ESLint
  `no-control-regex`-triggering `[\x00-\x1F...]` pattern — relevant if any new sanitization is
  added.

### Derived Conventions

- Ownership resolution is index-first (correlation JSON + sidecar marker), falling back to a
  bounded transcript scan for legacy sessions — never a full-file read.
- Non-fatal try/catch around every filesystem read; failures fall back conservatively to
  "treat as external/not owned" (fail-closed for ownership determination, as opposed to the
  fail-open adapter-capability pattern used on the RESUME path — these are different concerns
  and should not be conflated).
- Ownership index results are process-lifetime cached, acceptable because analytics CLI runs
  are short-lived.
- New session-domain logic belongs in `src/agents/core/session/*.ts`, agent-agnostic; agent
  specifics stay in the plugin layer, exposed via optional adapter capability methods only when
  genuinely agent-specific (not needed for this fix, since `hasOwnershipMarker` is already
  agent-agnostic).

---

## 4. Testing Landscape

### Existing Coverage

- `src/agents/core/__tests__/session-ownership.test.ts` — unit tests for
  `scanSessionsForClaudeId`; real temp dir via `node:fs`/`node:os` `tmpdir()`, hand-written JSON
  fixtures via a local `writeSession()` helper. Covers match/no-match/empty-dir/missing-dir/
  malformed-JSON/`_metrics.json`-skip cases.
- `src/agents/core/__tests__/session-origin-audit.test.ts` — unit tests for `appendAuditEvent`/
  `appendTranscriptMarker`; same tmpdir pattern; asserts JSONL line shape and non-fatal
  behavior on missing paths.
- `src/agents/core/__tests__/AgentCLI-resume.test.ts` — reference for CLI-level ownership
  gating: tests resume-ownership flow end to end using `vi.spyOn` on `ConfigLoader`,
  `ProviderRegistry`, `logger`, and the `session-origin-audit` module; injects adapter overrides
  (DI, no real fs).
- `src/cli/commands/analytics/__tests__/native-loader.test.ts` — **already has** a
  `describe('loadNativeSessions — external session labeling')` block asserting
  `startEvent.data.provider` becomes `'native-external'` when `hasOwnershipMarker()` returns
  false, and stays `'native'` when true, via a `makeDeps(hasMarker)` fake. **This is the closest
  existing ownership coverage for analytics, but it only tests the label, not exclusion** — it
  must be updated to assert `results` excludes/omits unowned sessions (e.g.
  `expect(results).toHaveLength(0)` when marker absent) once the fix lands.
- `src/cli/commands/analytics/__tests__/aggregator.test.ts` — tests `aggregate()`; fixtures use
  `provider: 'native'` but never `'native-external'`; asserts only the empty-deltas exclusion.
  No ownership-based filtering coverage.
- `src/cli/commands/analytics/__tests__/otel-loader.test.ts`, `model-normalizer.test.ts`,
  `otel-report.integration.test.ts`, `report/__tests__/*`, `cost/__tests__/*` — unrelated to
  ownership filtering.
- `src/agents/plugins/claude/__tests__/claude.conversations-processor.test.ts`,
  `src/agents/plugins/codex/__tests__/codex.conversations-processor.test.ts` — transcript
  parsing only, no ownership filtering.
- **No test files exist** for `src/cli/commands/analytics/data-loader.ts` or
  `src/cli/commands/analytics/sources/sessions-source.ts` (confirmed via glob — files exist, no
  `__tests__` counterpart).

### Testing Framework and Patterns

- Vitest `^4.1.5`, TypeScript `^5.3.3`, ESM throughout (`.js` extensions on relative imports).
- `vitest.config.ts`: `globals: true`, `environment: 'node'`, `include: ['src/**/*.test.ts',
  'src/**/*.spec.ts', 'tests/**/*.test.ts']`, thread pool, `isolate: true`.
- **Colocated `__tests__/` folders** next to the source file under test (e.g.
  `src/agents/core/__tests__/session-ownership.test.ts`) is the convention for unit tests. The
  top-level `tests/` tree (`tests/unit`, `tests/integration`) is reserved for CLI-command/e2e
  integration tests, distinct from the `src/**/__tests__` unit convention.
- Real temp directories via `node:fs`/`node:os` `tmpdir()` keyed by `process.pid`, cleaned in
  `beforeEach`/`afterEach` — used for session-ownership/session-origin-audit tests (no
  `mock-fs`/`memfs`).
- Dependency-injection boundary pattern (`NativeLoaderDeps`) — tests build fake `deps` objects
  inline; this is the pattern a new analytics regression test should reuse.
- `vi.spyOn` + `vi.restoreAllMocks()` in `afterEach` for module-level mocking; adapter/dep
  override factory pattern (`createAdapter(overrides)`) for AgentCLI tests.
- Session JSON fixtures are hand-built inline plain objects, not a shared fixture library.

### Coverage Gaps

- **Confirmed: analytics has no test today asserting it filters/excludes sessions by
  ownership.** `native-loader.test.ts` verifies only the cosmetic `provider` label — it does not
  assert that `loadNativeSessions`, `sessions-source.ts`, or `aggregator.ts` actually drop
  `'native-external'` sessions from counts or output. This is precisely the gap EPMCDME-13367
  must close, and no regression test currently guards against "blindly scraping all sessions."
- No tests exist for `data-loader.ts` (`MetricsDataLoader`) or `sources/sessions-source.ts`
  (`SessionsSource.load`) at all — the latter is the natural seam for an end-to-end assertion
  that native sessions are filtered by ownership before being returned/aggregated.
- `aggregator.test.ts` has no `'native-external'` fixture case, so no coverage that aggregation
  totals correctly exclude such sessions.
- No integration-level test (`tests/integration/`) exercises `codemie analytics` end-to-end with
  a mix of CodeMie-owned and non-CodeMie session files on disk — the acceptance criteria's
  language ("does not scrape all sessions blindly") suggests this level of test may be warranted
  in addition to the unit-level fix.

---

## 5. Configuration and Environment

### Environment Variables

- `CODEMIE_HOME` — overrides `~/.codemie` (tracked sessions, correlation index, audit logs).
  Read in `src/utils/paths.ts` (`getCodemieHome()`/`getCodemiePath()`).
- `CODEX_HOME` — overrides `~/.codex` for Codex rollout discovery. Read in
  `src/agents/plugins/codex/codex.paths.ts` (`getCodexHomePath()`/
  `getCodexDiscoverySessionRoots()`).
- `OPENCODE_STORAGE_PATH` — explicit override of OpenCode's session storage root. Read in
  `src/agents/plugins/opencode/opencode.paths.ts`. Not relevant today since OpenCode is not in
  `NATIVE_AGENTS`.
- `XDG_DATA_HOME` / `XDG_CONFIG_HOME` — standard XDG fallbacks used by OpenCode's storage/config
  path resolution.
- **No analytics-specific or ownership-filtering env var exists** (e.g. no
  `CODEMIE_ANALYTICS_*`) — nothing controls ownership-filtering behavior via environment
  variable today; any new behavior toggle would need a CLI flag (see Feature Flags below) rather
  than an env var, to match existing analytics conventions.

### Configuration Files

- `src/utils/paths.ts` — `getCodemieHome()`/`getCodemiePath()`: resolves `~/.codemie` (or
  `CODEMIE_HOME` override); used for tracked sessions dir, correlation metadata, sidecar
  markers, and the audit log.
- `src/agents/plugins/codex/codex.paths.ts` — `getCodexHomePath()`/
  `getCodexDiscoverySessionRoots()`: resolves `~/.codex` (or `CODEX_HOME` override) and
  enumerates both native (`sessions/`) and CodeMie-managed (`codemie/home/sessions/`) Codex
  roots.
- `src/agents/plugins/opencode/opencode.paths.ts` — resolves OpenCode's XDG-style storage dir
  (not currently consumed by analytics).
- No dedicated analytics config file beyond the CLI flags defined in `index.ts`.

### Feature Flags and Deployment Concerns

- `--no-scan-native` (existing, `AnalyticsOptions.scanNative`) — the only existing toggle;
  disables native-log discovery entirely (tracked-only). It does **not** selectively exclude
  external/non-CodeMie native sessions while still including CodeMie-tracked native ones — this
  is the closest existing lever, but not a substitute for the fine-grained per-session ownership
  filter this ticket requires.
- No existing flag distinguishes "include native-external sessions" vs "exclude them" — this is
  the exact gap the ticket needs to close. A new opt-in flag (e.g. `--include-external`) may be
  worth introducing during implementation if diagnostic visibility into excluded sessions is
  desired.
- **Session directories confirmed per plugin** (relevant to "local Claude session directories"
  language in the acceptance criteria):
  - Claude: `~/.claude/projects/` (`getProjectsDir()` in `claude.session.ts`,
    `join(homedir(), '.claude', 'projects')`).
  - Codex: `~/.codex/sessions/` (native) and `~/.codex/codemie/home/sessions/`
    (CodeMie-managed), or `${CODEX_HOME}/sessions` if set (`getCodexDiscoverySessionRoots()`).
  - Gemini: `~/.gemini/` — has a session adapter but is not in `NATIVE_AGENTS`, so not scanned
    by analytics today.
  - OpenCode: XDG-based storage path — has a session adapter but is not in `NATIVE_AGENTS`, so
    not scanned by analytics today.
  - Kimi: `~/.kimi-code/` — has a session adapter but is not in `NATIVE_AGENTS`, so not scanned
    by analytics today.
  - CodeMie's own tracked-session store (all plugins funnel correlation metadata here):
    `~/.codemie/sessions/` via `getCodemiePath('sessions')`.
- No deployment/CI concerns identified; this is a pure application-logic fix within the CLI.

---

## 6. Risk Indicators

- No existing test asserts analytics excludes ownership-unowned sessions — `native-loader.test.ts`
  covers only cosmetic labeling, exactly the gap this ticket must close with new regression
  coverage.
- Zero test coverage today for `data-loader.ts` and `sources/sessions-source.ts` — any new
  filter logic touching these files starts from an untested baseline.
- `native-loader.ts`'s `hasOwnershipMarker`/`buildOwnershipIndex` reimplements ownership-index
  logic in parallel with `session-ownership.ts`'s `scanSessionsForClaudeId` rather than reusing
  it — risk of drift/inconsistency between the RESUME-path ownership check and the
  analytics-path ownership check if the two are not reconciled or explicitly kept separate by
  design.
- `codex.plugin.ts` has no `resolveResumeOwnership` implementation on the RESUME path (a
  pre-existing gap unrelated to this ticket) — must confirm the analytics fix does not
  implicitly assume a Claude-only ownership mechanism; it should not, since `hasOwnershipMarker`
  is already agent-agnostic, but this should be explicitly verified during implementation.
- The original PR #403 design **explicitly decided** not to hide external sessions ("No
  sessions are hidden — all are surfaced, external ones are clearly marked"). This ticket
  reverses that decision for analytics specifically; care is needed to avoid inadvertently
  changing the RESUME-path UX (which should keep informing users about external sessions when
  resuming) — the exclusion must be scoped to the analytics pipeline only.
- Prior code-review fixes must be preserved when touching `hasOwnershipMarker`/
  `buildOwnershipIndex`: CR-002 (bounded 4KB/10-line scan, avoid full-file reads), CR-003
  (index-first check ordering), CR-R-002 (`_metrics.json` via `.endsWith`, not `.includes`).
  Regressing any of these would reintroduce previously-fixed defects.
- No integration-level test exercises `codemie analytics` end-to-end with a mix of owned/
  external session files on disk — the acceptance criteria's explicit call for regression
  coverage that analytics "does not scrape all sessions blindly" suggests this level of test may
  be expected, not just a unit-level assertion.
- `formatter.ts`'s `'native-external'` display branch becomes dead/unreachable code once
  exclusion happens upstream at the loader/source level — needs an explicit decision (remove,
  or repurpose behind a new `--include-external` debug flag).
- `NATIVE_AGENTS` is hardcoded to `['claude', 'codex']`; Gemini/OpenCode/Kimi have their own
  `discoverSessions()` implementations but are not included in `NATIVE_AGENTS`, so analytics
  does not scan them at all today. This is confirmed out of scope for this fix (no code changes
  needed for those plugins), but should be called out explicitly in the plan/spec so the fix is
  not scoped too broadly based on the ticket's "e.g. Gemini/OpenCode/Kimi" phrasing — only
  Claude and Codex native sessions are actually affected by the current bug.
- No analytics-specific environment variable exists to toggle ownership filtering — any new
  configurability should be a CLI flag (matching the `--no-scan-native` convention), not an env
  var, to stay consistent with existing analytics configuration conventions.

---

## 7. Summary for Complexity Assessment

This is a narrowly-scoped, well-localized fix. The defect lives almost entirely in one file —
`src/cli/commands/analytics/native-loader.ts`, lines ~518-521 — where an existing ownership
signal (`hasOwnershipMarker`) is already computed but only used to *label* a session as
`'native-external'` rather than exclude it from the returned array. The primary layers touched
are the analytics session-discovery layer (`native-loader.ts`, and possibly
`sources/sessions-source.ts` as an alternate/secondary filter point) and the presentation layer
(`formatter.ts`, where the now-obsolete display-only branch needs to be removed or repurposed).
No changes are required to the agents/core ownership primitives themselves
(`session-ownership.ts`, `session-origin-audit.ts`) or to the plugin layer
(`claude.plugin.ts`, `codex.plugin.ts`) — both Claude and Codex already flow through the single
shared `NATIVE_AGENTS` loop and the agent-agnostic `hasOwnershipMarker` check, and Gemini/
OpenCode/Kimi are confirmed out of scope since they are not in `NATIVE_AGENTS` at all today.
Estimated file change surface is small: 1-2 source files for the core fix (`native-loader.ts`,
possibly `sessions-source.ts` and/or `types.ts`/`index.ts` if an opt-in `--include-external`
flag is added), plus `formatter.ts` cleanup, plus test files.

Technical novelty is low — this follows an established pattern (the RESUME-path ownership
gating from PR #403) closely, reusing the same `hasOwnershipMarker` boolean signal that already
exists and is already tested for its labeling behavior. No new environment variables or config
files are needed; any new toggle should be a CLI flag consistent with the existing
`--no-scan-native` convention. The main judgment call is whether to reuse/reconcile the existing
`session-ownership.ts` primitive versus continuing with `native-loader.ts`'s parallel index
implementation, and whether to preserve an escape hatch (debug flag) for seeing excluded
sessions. Neither introduces new architectural concepts.

Test coverage posture is mixed-to-thin and is itself part of the deliverable: the closest
existing test (`native-loader.test.ts`'s external-session-labeling suite) asserts the current
buggy tag-only behavior and must be rewritten to assert actual exclusion; `data-loader.ts` and
`sessions-source.ts` have zero existing tests; and no integration test exists for the CLI
end-to-end. Key risk factors for complexity scoring: (1) the behavior-reversal risk relative to
the explicit prior design decision ("no sessions are hidden") — this is an intentional,
ticket-mandated policy change scoped to analytics only, not a regression, but must be
communicated as such in the implementation; (2) the need to preserve three prior code-review
fixes (bounded scan, index-first ordering, `_metrics.json` suffix check) while modifying
adjacent logic; and (3) the acceptance criteria's explicit demand for regression coverage that
proves analytics no longer "blindly scrapes" — this likely requires both an updated unit test in
`native-loader.test.ts` and a new integration-level test under `tests/integration/`, pushing this
from a "trivial one-line fix" toward a "small, well-defined, low-risk" change with a
correspondingly modest test-writing effort attached.
