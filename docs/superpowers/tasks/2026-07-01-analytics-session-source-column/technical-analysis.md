# Technical Research

**Task**: analytics session report sdlc-factory detection
**Generated**: 2026-07-01
**Research path**: filesystem (codegraph MCP tool not available — filesystem Explore fallback used)

---

## 1. Original Context

On the analytics dashboard produced by the `codemie analytics --report ...` command, there is a Sessions tab/table. Add a new column (positioned right after the 'Branch' column) that signals what tooling/framework was used during that session. Specifically:
1. Detect CodeMie SDLC Factory usage: if any of the skills `sdlc-light`, `sdlc-task`, `sdlc-autonomous` (or other sdlc-factory skills) were invoked in the session, label it as 'CodeMie AI Factory' (or similar).
2. If SDLC Factory was NOT used, but skills/commands from other known frameworks/bundles were used, detect those too: 'superpowers' skill bundle, 'open-spec'/'openspec', 'speckit', 'bmad'. Each should map to its own label.
3. If none of the above signals are found in the session, label it 'Pure chat'.
4. The detection mechanism must be extensible/pluggable — implement it using a design pattern like Strategy or Command/Chain-of-Responsibility, so new frameworks/bundles can be added as new detectors without modifying a big if/else chain.

I need you to research:
- Where the analytics report generation code lives (likely something like an OTEL analytics source / session-detail report, given a recent commit 95fb54a 'feat(analytics): add OTEL analytics source with session-detail report'). Find the exact files.
- How the Sessions tab/table is rendered (HTML/React/template) — find where columns like 'Branch' are defined, so I know where to insert the new column.
- What data is available per session that could reveal which skills/commands were invoked (e.g., transcript logs, tool_use events, skill invocation events, slash commands) — find how skill/command invocations are currently captured or parsed in analytics data, if at all.
- Any existing mapping/registry patterns in this codebase (e.g. plugin registry, provider registry) that already follow Strategy/Command patterns I should mirror for consistency with `.ai-run/guides/architecture/architecture.md`.
- Relevant guide content from `.ai-run/guides/architecture/architecture.md` and `.ai-run/guides/development/development-practices.md` and `.ai-run/guides/standards/code-quality.md` that constrains how this should be implemented.

---

## 2. Codebase Findings

### Existing Implementations

**Analytics pipeline (data flow: source → aggregator → payload → HTML/client):**

- `src/cli/commands/analytics/index.ts` — CLI entry point; `createAnalyticsCommand()` / `runAnalytics()`; defines both `analytics` (default `SessionsSource`) and `analytics otel` (`OtelSource`) subcommands (lines 16–40).
- `src/cli/commands/analytics/sources/types.ts` — `AnalyticsSource` interface (the existing pluggable-source seam, effectively a Strategy pattern already in production).
- `src/cli/commands/analytics/sources/sessions-source.ts` — `SessionsSource` implementation (local tracked sessions + native agent logs).
- `src/cli/commands/analytics/sources/otel-source.ts` — `OtelSource` implementation (flattened `otel-events.jsonl`).
- `src/cli/commands/analytics/aggregator.ts` — `AnalyticsAggregator.aggregate()` builds `SessionAnalytics` from `MetricDelta[]`; aggregates named invocations at lines 433–435 via `aggregateNamedInvocations()`.
- `src/cli/commands/analytics/otel-loader.ts` — parses OTEL events; `skill_activated` events carry `skill.name` (line ~223), `subagent_completed` carries `agent_type` (line ~249); mapped into `DispatchEvent` timeline entries. Also documents at line 3: native Claude Code emits no cwd/git branch, so Project/Branch are only available when the codemie-claude-otel plugin was active (native-only sessions fall back to "Unknown").
- `src/cli/commands/analytics/native-loader.ts` — applies the same named-invocation extraction to native (untracked) sessions.
- `src/cli/commands/analytics/report/payload-builder.ts` — dedupes sessions, builds flat `ReportSessionRecord[]` for the client; carries `skillInvocations`/`agentInvocations`/`commandInvocations` at lines 84–86.
- `src/cli/commands/analytics/report/types.ts` — `ReportSessionRecord` (lines 10–43) with `skillInvocations`, `agentInvocations`, `commandInvocations` (`NamedInvocationStats[]`), `dispatches?: DispatchEvent[]`. No `tooling`/`framework`/`sessionSource` field exists today.
- `src/cli/commands/analytics/types.ts` — `SessionAnalytics` (lines 79–133), the per-session aggregate; also has no framework/source field yet.
- `src/cli/commands/analytics/cost/cost-enricher.ts` — demonstrates the codebase's DI-for-testability convention (`EnricherDeps` interface, line 29–34); relevant precedent for how a new detector module should be structured (pure function + injected deps, unit-tested).
- `src/agents/plugins/claude/session/claude-named-invocations.ts` — single source of truth for extracting skill/agent/command names from Claude message logs via `extractNamedInvocations()` (lines 61–89):
  - Skills: `tool_use` block with `name === 'Skill'` → `input.skill` (e.g. `"codemie:msgraph"`, `"superpowers:test-driven-development"`).
  - Agents: `tool_use` block with `name === 'Agent'` (this CLI) or `name === 'Task'` (standard Claude Code) → `input.subagent_type` (e.g. `"sdlc-factory:tech-analyst"`, `"superpowers:brainstorming"`, `"Explore"`).
  - Slash commands: user message text containing `<command-name>...</command-name>` with a sibling `<command-message>` (ensures a real invocation, not documentation) → e.g. `"sdlc-task"`, `"sdlc-light"`, `"tech-lead"`.
- `src/agents/plugins/claude/session/processors/claude.metrics-processor.ts` — calls `extractNamedInvocations()` live during session recording.

**Framework/bundle name inventory found in this repo:**

| Bundle | Where defined in this repo | Invocation shape observed |
|---|---|---|
| SDLC Factory | Skills live externally (`epm-cdme/codemie-public-skills`, path `ai-packages/sdlc-factory/skills/{name}/SKILL.md`); referenced in `skills-lock.json` (`complexity-scoring`, `memory`, `product-owner`, `requirements-intake`) | As skill: unnamespaced name (e.g. `memory`) or namespaced `sdlc-factory:memory` in `agentInvocations`. As slash command: `sdlc-task`, `sdlc-light`, `sdlc-autonomous` (unnamespaced, no `sdlc-factory:` prefix on commands) |
| superpowers | Cached locally under `.codex/plugins/cache/openai-curated/superpowers/{version}/skills/` (13 skills: `brainstorming`, `writing-plans`, `test-driven-development`, etc.) | Namespaced `superpowers:<skill>` in skill/agent invocations |
| speckit | `src/frameworks/plugins/speckit.plugin.ts` line 21 — framework name `'speckit'`, display "SpecKit", supported agents claude/gemini, init marker directory `.specify/` | Filesystem marker `.specify/`, or possible `speckit` slash-command/agent name |
| bmad | `src/frameworks/plugins/bmad.plugin.ts` line 36 — framework name `'bmad'`, display "BMAD Method", init marker `_bmad/` (also checks `.bmad/`) | Filesystem marker `_bmad/`/`.bmad/`, or possible `bmad` agent name |
| openspec / open-spec | **Not found anywhere in this repo** — no plugin, no skill, no config reference | Unknown — must be pattern-matched heuristically (e.g. skill/command name containing `openspec` or `open-spec`) since there is no existing integration to mirror |

Note: `sdlc-light`, `sdlc-task`, `sdlc-autonomous` themselves are not found as registered skills/plugins in this repo (they are slash commands from the external `sdlc-factory` skill bundle, consistent with how they appear in `commandInvocations`).

### Architecture and Layers Affected

Per `.ai-run/guides/architecture/architecture.md` (plugin-based 5-layer architecture: CLI → Registry → Plugin → Core → Utils), this feature touches:

- **Core/Report-pipeline layer** — new pure detection logic, analogous to `cost-enricher.ts` (DI + unit tested). Recommended new module e.g. `src/cli/commands/analytics/report/framework-detector.ts` (or `src/analytics/...` if a dedicated sub-tree is preferred) exposing `detectSessionSource(session): SessionSourceLabel`.
- **Registry layer** — a small registry of detectors (`SessionLabelRegistry`/detector array), mirroring existing registries (`AgentRegistry`, `ProviderRegistry`, `FrameworkRegistry`, `MigrationRegistry`).
- **Payload-builder / aggregator layer** — `SessionAnalytics` and `ReportSessionRecord` need a new field (e.g. `sessionSource: string`) populated during payload building, since all the raw invocation data (`skillInvocations`, `agentInvocations`, `commandInvocations`) is already flowing through this pipeline — no new telemetry/capture is required.
- **Client rendering layer** — `src/cli/commands/analytics/report/client/app.js`, function `VIEWS.sessions` (lines ~786–825), which builds the Sessions table.

### Integration Points

- **Exact 'Branch' column location**: `src/cli/commands/analytics/report/client/app.js`, `VIEWS.sessions`.
  - Header array (line ~809): `['Date', 'Prompt', 'Agent', 'Project', 'Branch', 'Turns', 'Net lines', 'Input', 'Output', 'Cached', 'Cost']` — Branch is index 4.
  - Row-cell array (lines ~813–817): `branchCell` is emitted at the same index 4, immediately before `fmtNum(s.turns)`.
  - Right-align mask array (line ~819): `[false, false, false, false, false, true, true, true, true, true, true]` — must also get a new entry inserted at index 5.
  - New column must be inserted **at index 5** (right after Branch), shifting Turns/Net lines/etc. one position each. All three arrays (header, row cells, alignment mask) must be updated together or columns misalign — the alignment mask is flagged as the most commonly missed edit.
  - Optional: the search filter string (line ~805) currently concatenates sessionId/agentName/project/branch/title; decide whether the new label should be searchable too.
- **Data already available to the client**: `s.skillInvocations`, `s.agentInvocations`, `s.commandInvocations` are already present on each session record reaching `app.js`; a `dispatchCounts(session, 'skill'|'agent'|'command')` helper (lines ~861–869) already normalizes access across both dispatch-events and invocation-array representations — useful if detection is implemented client-side instead of server-side.
- **CSV exporter** (`src/cli/commands/analytics/report/exporter.ts`, lines 39/59) has its own Branch column and would need a parallel update if CSV export should also carry the new label (out of scope unless requested).
- **Multiple frameworks per session**: a session can invoke both an SDLC Factory command and a superpowers skill. The task specifies a single label, so a priority order is needed (task explicitly places SDLC Factory detection first, i.e., "if SDLC Factory was NOT used, then check others" — this maps directly to first-match-wins Chain-of-Responsibility ordering: SDLC Factory > superpowers > openspec > speckit > bmad > Pure chat).

### Patterns and Conventions

**Registry patterns already in the codebase (mirror one of these for consistency):**

| Registry | File | Pattern |
|---|---|---|
| AgentRegistry | `src/agents/registry.ts` | Lazy-init Map-based registry, static methods `getAgent()`/`getAllAgents()`/`getAgentNames()` |
| ProviderRegistry | `src/providers/core/registry.ts` | Multi-map registry; polymorphic `.supports(provider)` predicate on each registered component to find a match |
| FrameworkRegistry | `src/frameworks/core/registry.ts` | Map-based with availability flag; `registerFramework(adapter)`, filtered by `.metadata.supportedAgents` |
| MigrationRegistry | `src/migrations/registry.ts` | Simplest: `static migrations: Migration[]`, `register()`/`getAll()`/`get(id)` |
| WorkflowRegistry | `src/workflows/registry.ts` | Functional (no class), static template arrays, pure query functions |

**No dedicated Strategy/Chain-of-Responsibility class exists yet**, but `ProviderRegistry`'s `.supports()` predicate pattern and the `AnalyticsSource` interface (`sources/types.ts`) are the closest existing precedents for a pluggable, first-match-wins seam. `src/workflows/detector.ts` (VCS provider detection) is a procedural if/else chain — explicitly the anti-pattern this task wants to avoid replicating.

**Recommended shape** (consistent with the above, and with `NamedInvocationStats`/`ReportSessionRecord` shapes already in the codebase):

```typescript
export interface SessionLabelDetector {
  name: string; // e.g. 'sdlc-factory', 'superpowers', 'openspec', 'speckit', 'bmad'
  label: string; // display label, e.g. 'CodeMie AI Factory'
  detect(session: ReportSessionRecord | SessionAnalytics): boolean;
}
```
A registry holds an ordered list of detectors (SDLC Factory first per requirement #2), iterates in order, returns the first match's `label`, and falls back to `'Pure chat'` if none match — a first-match-wins Chain-of-Responsibility, consistent with existing `.supports()`-style predicate matching in `ProviderRegistry`.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — documents the plugin-based 5-layer architecture (CLI → Registry → Plugin → Core → Utils); used above to place the new detector module.
- `.ai-run/guides/development/development-practices.md` — error handling (specific error classes, `createErrorContext`, `logger.error` + `formatErrorForUser`), logging (`logger.debug`/`info`/`warn`/`error`, always `sanitizeLogArgs()`), async/await only, `exec()` from `src/utils/processes.ts` for process spawning.
- `.ai-run/guides/standards/code-quality.md` — naming (`camelCase` vars/functions, `PascalCase` classes/interfaces, `UPPER_SNAKE_CASE` constants, `kebab-case.ts` files, `*.test.ts` tests), explicit return types on exported functions, `interface` over `type` for object shapes, functions <50 lines, files <500 lines, single responsibility, no `console.log` (use `logger.debug()`).
- `.ai-run/guides/integration/external-integrations.md` — documents the analytics session flow (`onSessionEnd` hook, `SessionSyncer` reading JSONL deltas, POST to `v1/metrics`); background context for how session data reaches the analytics pipeline in the first place.
- `docs/ANALYTICS-REPORT.md` — authoritative spec for the analytics dashboard; documents all eight views (Overview, Agents, Projects, Tools & Models, Activity, Efficiency, Cost, Sessions) and the session-detail modal, which already surfaces "Skills / Agent subtypes / Slash commands" chip lists (i.e., the raw data this feature would classify is already user-visible elsewhere in the UI).
- `docs/superpowers/plans/2026-06-19-analytics-source-seam.md` — the design doc that introduced the `AnalyticsSource` seam (`SessionsSource`/`OtelSource`), explicitly intended so that future backends "become drop-in `AnalyticsSource` implementations without changing the CLI." This is the closest architectural precedent/ADR for building another pluggable seam (the session-label detector).
- `docs/superpowers/tasks/2026-06-23-codex-analytics-report/spec.md` — Codex analytics parity spec; shows how different agent types feed the same `ReportSessionRecord` shape.

### Architectural Decisions

- The `AnalyticsSource` seam (per the plan doc above) is the closest recorded ADR for "pluggable analytics component" — the new detector registry should follow the same spirit (interface + registry + ordered/first-match strategy) rather than ad hoc branching.
- `otel-loader.ts` inline note: Project/Branch are only populated when the codemie-claude-otel plugin was active; native-only sessions fall back to "Unknown" — same caveat likely applies to invocation-array completeness for native/untracked sessions, which is a relevant risk for the new detector's coverage.

### Derived Conventions

- New per-session pure-function modules in this pipeline (e.g. `cost-enricher.ts`) take an explicit `Deps` object for injected dependencies and are unit tested in a co-located `__tests__/` directory — the detector module should follow the same shape (`detectSessionSource(session, deps?)`, unit-tested independently of the full report pipeline).

---

## 4. Testing Landscape

### Existing Coverage

- `tests/integration/analytics.test.ts` — E2E pipeline validation against a golden dataset (`tests/integration/metrics/fixtures/claude/expected-session.json`, `expected-metrics.jsonl`).
- `src/cli/commands/analytics/__tests__/aggregator.test.ts` — 14 cases covering branch attribution, change metrics, title parsing, and **named-invocation aggregation** (skill/agent/command arrays) — this is the layer a new "session source" field would be added to.
- `src/cli/commands/analytics/__tests__/native-loader.test.ts` — native session discovery/synthesis/dedup.
- `src/cli/commands/analytics/__tests__/otel-loader.test.ts` — OTEL event parsing.
- `src/cli/commands/analytics/__tests__/otel-report.integration.test.ts` — OTEL source → report pipeline end-to-end.
- `src/cli/commands/analytics/report/__tests__/report-generator.test.ts` — 8 cases for HTML injection/escaping/Chart.js inlining.
- `src/cli/commands/analytics/report/__tests__/payload-builder.test.ts` — 11 cases covering session dedup, multi-branch attribution, cost mapping, and skill/agent/command invocation pass-through (lines 215–233, 248–255) — this is exactly where a new `sessionSource` field would need a pass-through test.
- `src/agents/plugins/claude/session/__tests__/claude-named-invocations.test.ts` — confirms `sdlc-factory:tech-analyst`, `superpowers:code-reviewer` (agent invocations) and `tech-lead`, `analytics` (slash commands) are already extracted correctly today (lines 39, 40, 62–66).

### Testing Framework and Patterns

- Vitest throughout; unit tests co-located in `__tests__/`, integration tests under `tests/integration/`.
- Dynamic-import mocking convention (per `.ai-run/guides/testing/testing-patterns.md`): spies must be set up in `beforeEach` and the target module imported dynamically inside the test body (`await import(...)`) — static top-level imports bypass spies.
- `setupTestIsolation()` / `getTestHome()` (`tests/helpers/test-isolation.ts`) give each test a unique `CODEMIE_HOME` for parallel-safe execution.

### Coverage Gaps

- No detector/classification module exists yet, so there is (necessarily) no test coverage for "session source" detection — this is net-new test surface, not a regression risk.
- `SessionAnalytics` (types.ts, lines 79–133) and `ReportSessionRecord` (report/types.ts, lines 10–43) currently have no `sessionSource`/`framework` field — adding one requires new unit tests in `aggregator.test.ts` and `payload-builder.test.ts` plus a new dedicated test file for the detector module itself (e.g. `src/cli/commands/analytics/__tests__/session-source-detector.test.ts`).
- `app.js` (the client renderer) has no existing unit test harness in the threads' findings — if detection or column rendering logic is added there, verify whether `report-generator.test.ts` snapshot-tests rendered HTML/JS output that would need updating.

---

## 5. Configuration and Environment

### Environment Variables

- General CodeMie config env vars (`src/utils/config.ts`): `CODEMIE_PROVIDER`, `CODEMIE_API_KEY`, `CODEMIE_BASE_URL`, `CODEMIE_MODEL`, `CODEMIE_TIMEOUT`, `CODEMIE_DEBUG`, `CODEMIE_URL`, `CODEMIE_AUTH_METHOD`, `CODEMIE_INTEGRATION_ID`, `CODEMIE_INTEGRATION_ALIAS`.
- No dedicated `OTEL_*` or `ANALYTICS_*` env vars were found; OTEL data is loaded via an explicit `--file` CLI flag (`loadOtelSessions({ file })`), not environment configuration.

### Configuration Files

- `~/.codemie/codemie-cli.config.json` (global) / `.codemie/codemie-cli.config.json` (project) — provider/profile config, not analytics-specific.
- `~/.codemie/sessions/` — tracked CodeMie session storage (JSON + JSONL metrics), the primary input to `SessionsSource`.
- `skills-lock.json` — registered skill manifest, source of the SDLC Factory skill name inventory used above.

### Feature Flags and Deployment Concerns

- No feature flags gate this area currently. The `analytics` command has a `--no-scan-native` flag (skip native agent-log discovery) and the `analytics otel` subcommand has `--file`/`--user` flags — none are directly relevant to the new column but confirm the CLI surface that would carry the feature end-to-end.
- Framework markers for `speckit` (`.specify/`) and `bmad` (`_bmad/`/`.bmad/`) are filesystem directories created by `src/frameworks/plugins/{speckit,bmad}.plugin.ts` at framework-init time — these are workspace-level markers, not session-transcript signals, and are a materially different detection surface than skill/agent/command invocation names. This is a design decision the implementer needs to resolve explicitly (see risks).

---

## 6. Risk Indicators

- No codegraph MCP available for this repo — filesystem Explore fallback was used for all five research dimensions; if codegraph is expected to be available in this environment, treat this as an environment setup gap rather than a repo gap.
- **openspec/open-spec has zero footprint in this repo** — no plugin, no skill manifest entry, no config reference was found anywhere. The detector for this bundle cannot mirror an existing pattern and must be built from an assumed/heuristic naming convention (e.g. matching `openspec`/`open-spec` substrings in skill or command names) — this is the least-grounded of the five detectors and carries the highest risk of silent false negatives.
- **Detection-surface inconsistency across bundles**: SDLC Factory/superpowers signals live in transcript-derived data (`skillInvocations`/`agentInvocations`/`commandInvocations`), while speckit/bmad signals (as currently implemented elsewhere in this repo) are *filesystem markers* (`.specify/`, `_bmad/`) created at project-init time, not per-session events. A detector keyed only on invocation names will likely never fire for speckit/bmad unless those frameworks also emit skill/agent/command names into the session transcript. This needs an explicit product decision: should the detector also inspect `session.workingDirectory` for marker directories, or is invocation-name matching (e.g. an agent/skill literally named `speckit`/`bmad`) considered sufficient? Not resolved by this research.
- `sdlc-light`, `sdlc-task`, `sdlc-autonomous` appear only as **slash commands** (`commandInvocations`), not as skill or agent invocations, and are **not namespaced** with an `sdlc-factory:` prefix — a detector that only checks for a `sdlc-factory:` prefix on skills/agents would miss sessions that only used these top-level slash commands. The detector must check all three invocation arrays (`skillInvocations`, `agentInvocations`, `commandInvocations`) and use both prefix-match (`sdlc-factory:`) and exact/allow-list match (`sdlc-light`, `sdlc-task`, `sdlc-autonomous`, and any other declared "sdlc-factory skills") to avoid false negatives.
- No existing multi-label session data model: `ReportSessionRecord`/`SessionAnalytics` currently store zero framework/source classification. Adding a single-string field forces a priority decision when multiple bundles appear in one session (recommend first-match-wins ordering seeded from the ticket's own precedence: SDLC Factory checked first, then the other bundles, then `Pure chat`).
- Coverage-limited scenario for native/untracked sessions: `otel-loader.ts` documents that native Claude Code sessions have no cwd/git branch by default, so branch data is "Unknown" for native-only sessions — invocation-array completeness for native sessions was not independently verified and may have similar limitations, which could make the new column silently degrade for that session type. Needs a follow-up check of `native-loader.ts` extraction coverage before implementation is considered feature-complete.
- Three-place UI edit risk in `app.js` (header array, row-cell array, alignment-mask array) is explicitly documented as easy to get wrong — the alignment-mask array is called out as the most commonly missed edit when inserting a column.
- No dedicated Strategy/Chain-of-Responsibility base class exists in the codebase to extend; the closest patterns (`ProviderRegistry.supports()`, `AnalyticsSource` interface, `AgentRegistry`) are all slightly different shapes, so the new detector registry will be a new (small) pattern rather than a drop-in reuse of an existing one — moderate design risk, low implementation risk given the small surface area.
- No test coverage exists yet for a "session source" concept anywhere in the codebase (expected, since the feature doesn't exist) — full new unit-test surface required per project convention (`aggregator.test.ts`, `payload-builder.test.ts`, and a new detector test file), consistent with the "Tests Only On Explicit Request" policy in AGENTS.md if the user separately requests test coverage.

---

## 7. Summary for Complexity Assessment

This task touches four architectural layers in the existing analytics pipeline: (1) a new small **Core** module for pluggable detection (new file, e.g. `report/framework-detector.ts` or a new `src/analytics/` sub-tree with `core/types.ts` + `registry.ts` + `plugins/*.detector.ts`, mirroring existing registries like `ProviderRegistry`/`FrameworkRegistry`), (2) the **aggregation/payload-builder layer** (`aggregator.ts`, `payload-builder.ts`, `types.ts`, `report/types.ts`) to add and populate a new `sessionSource`/`framework` field on `SessionAnalytics` and `ReportSessionRecord`, (3) the **client rendering layer** (`report/client/app.js`, `VIEWS.sessions`) requiring three coordinated array edits (header, row cells, alignment mask) to insert the column after Branch, and optionally (4) `report/exporter.ts` if CSV export should carry the same label. Estimated file-change surface is roughly 6-10 files: 1-4 new detector files, 2-3 modified pipeline files, 1 modified client file, plus corresponding test files. This sits at the boundary of Medium/High per the project's own complexity guidance (2-5 files standard vs 6+ architecture-sensitive), leaning High mainly because of the new pluggable-pattern design work rather than raw line count.

Technical novelty is moderate: all the raw data needed (skill/agent/command invocation names) is **already captured and flowing through the pipeline today** — no new telemetry or transcript parsing is required, which meaningfully de-risks the task. The novel part is (a) introducing a first Strategy/Chain-of-Responsibility-style registry into this pipeline (no exact precedent exists, though `ProviderRegistry`'s `.supports()` predicate and the `AnalyticsSource` seam are close analogues to mirror), and (b) resolving the ambiguity around speckit/bmad detection, which in this repo are currently only implemented as *filesystem init markers*, not transcript signals — meaning invocation-name-only detection may under-detect those two bundles unless the product accepts that limitation or the detector also inspects `session.workingDirectory`.

Test coverage posture for the surrounding pipeline is strong (comprehensive Vitest suites for aggregator, payload-builder, native-loader, otel-loader, report-generator, and named-invocation extraction, all with dozens of passing cases), so the new detector module can be added with high confidence and testability, following the existing DI-and-pure-function convention seen in `cost-enricher.ts`. Key risk factors that should weight the complexity score up: (1) openspec/open-spec has zero existing footprint in the repo and requires a heuristic, unverified detection approach; (2) the sdlc-factory command names (`sdlc-light`/`sdlc-task`/`sdlc-autonomous`) are unnamespaced slash commands distinct from the namespaced `sdlc-factory:` skill/agent prefix, so the detector needs both a prefix-match and an explicit allow-list to avoid false negatives; (3) the three-place client-side array edit in `app.js` is a known footgun for column misalignment; (4) a single-label-per-session model requires an explicit priority/precedence decision when a session touches multiple bundles.
