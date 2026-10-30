# Technical Research

**Task**: session-report analytics paths
**Generated**: 2026-10-21
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-14585 — CodeMie analytics JSON files are generated inside the user's repo under docs/codemie/analytics (codemie-analytics-[email-]<sessionId>.json). Cause: src/cli/commands/analytics/report/session-report.ts:68 defaults output to process.cwd()/docs/codemie/analytics when no outputPath is given; BaseAgentAdapter.maybeWriteSessionReport (src/agents/core/BaseAgentAdapter.ts ~line 69) calls it on session exit for agents with sessionAnalyticsReport: true (claude, codex, copilot-cli, opencode, pi). Fix: default should live under CodeMie home via getCodemiePath() (src/utils/paths.ts:385); explicit outputPath and CODEMIE_SESSION_ANALYTICS_REPORT=0 opt-out keep working; filename unchanged. Update SessionReportOptions.outputPath comment (line 18) and any docs/README mentioning docs/codemie/analytics. Tests to extend: src/cli/commands/analytics/report/__tests__/session-report.test.ts and src/agents/core/__tests__/BaseAgentAdapter-session-report.test.ts; add a regression test with cwd set to a temp git-like folder proving nothing lands under docs/codemie/analytics. Acceptance: no writes under docs/codemie/analytics; not in active repo by default; deterministic documented path outside repo unless explicitly configured; existing collection/sync still works; regression test; legacy files in docs/codemie/analytics not used for new files.

---

## 2. Codebase Findings

### Existing Implementations
- `/Users/mert_efe/codemie-installers/codemie-code/src/cli/commands/analytics/report/session-report.ts` — `generateSessionReport(options)`; lines 65-68 compute `outputPath = options.outputPath ?? join(process.cwd(), 'docs','codemie','analytics', \`codemie-analytics-${emailPrefix}${sessionId}.json\`)`. Imports only `join` from `node:path`. Line 18 JSDoc on `outputPath` describes the cwd-relative default. Line 71 calls `writeReportWithFallback(..., outputPath, false)` (no home/tmp fallback; errors propagate).
- `/Users/mert_efe/codemie-installers/codemie-code/src/agents/core/BaseAgentAdapter.ts:69-109` — private `maybeWriteSessionReport(env)`: returns if `metadata.sessionAnalyticsReport` falsy, if `env.CODEMIE_SESSION_ANALYTICS_REPORT === '0'`, or no `CODEMIE_SESSION_ID`; resolves email from `CODEMIE_PROFILE_CONFIG` or `ConfigLoader`; calls `generateSessionReport({ sessionId, userEmail })` without outputPath; errors logged as warn, swallowed.
- `/Users/mert_efe/codemie-installers/codemie-code/src/cli/commands/analytics/report/report-generator.ts` — `emailSlug`, `generateReportJson`, `writeReportWithFallback` (fallback to homedir/tmpdir only when allowFallback true). Need to confirm `generateReportJson` creates parent directories (not read in full).
- `/Users/mert_efe/codemie-installers/codemie-code/src/utils/paths.ts:367-387` — `getCodemieHome()` (honours `CODEMIE_HOME`, else `~/.codemie`) and `getCodemiePath(...segments)`. No existing analytics-specific path helper.
- `src/agents/core/AgentCLI.ts:404` — `--no-analytics-report` sets `CODEMIE_SESSION_ANALYTICS_REPORT=0`. `src/agents/core/types.ts:345` — `sessionAnalyticsReport` metadata flag. Opted-in plugins: claude, codex, copilot-cli, opencode, pi.

### Architecture and Layers Affected
- CLI command layer (analytics report generator: `session-report.ts`) and path utility layer (`src/utils/paths.ts`, consumed only). Agent core layer (`BaseAgentAdapter`) calls the generator but needs no change per current code (does not pass outputPath).

### Integration Points
- `BaseAgentAdapter` -> dynamic import of `session-report.js` -> `SessionsSource`, `enrichCosts`, `AnalyticsAggregator`, `buildPayload`, `report-generator`.
- Also the `analytics --export json` CLI path shares report-generator building blocks (its own default output was not inspected; grep of `'docs'` in `src/cli/commands/analytics` outside tests found only `session-report.ts:68`).
- `.gitignore:91` ignores `/docs/codemie/analytics/`. The repo working tree contains local legacy JSON files in `docs/codemie/analytics/` (ignored, not tracked: `git ls-files docs/codemie` is empty).

### Patterns and Conventions
- Per AGENTS.md: use `getCodemiePath()` instead of hard-coded `~/.codemie`; ES modules with `.js` import extensions; `@/` alias preferred over deep relative imports (existing file uses relative imports); logger not console.

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `.ai-run/guides/usage/project-config.md` (paths, CODEMIE_HOME), `.ai-run/guides/testing/testing-patterns.md`, `.ai-run/guides/architecture/architecture.md` exist per AGENTS.md; not read in detail for this report.
- `/Users/mert_efe/codemie-installers/codemie-code/docs/ANALYTICS-REPORT.md:260` — only live user doc stating the path: "writes a JSON analytics report ... to `./docs/codemie/analytics/codemie-analytics-<session_id>.json`" (section "Automatic Per-Session Report on Exit", lines 257-265).
- `openwiki/workflows/agent-launch-and-session-telemetry.md:120` describes the report but does not state the path (generated; do not hand edit).
- README.md and docs/COMMANDS.md: no matches for `docs/codemie/analytics`.
- Historical design docs mentioning the path (superseded records, not user docs): `docs/superpowers/specs/2026-07-09-session-exit-analytics-report-design.md`, `docs/superpowers/plans/2026-07-09-session-exit-analytics-report.md`, `docs/superpowers/work-items/session-exit-analytics-report.md`, and several `docs/superpowers/tasks/*` and pi specs/plans.

### Architectural Decisions
- Prior design (2026-07-09 spec) chose the cwd-relative default; this ticket reverses it. No ADR found elsewhere.

### Derived Conventions
- Per-user runtime data lives under `getCodemiePath(...)` (logs, sessions, etc.).

---

## 4. Testing Landscape

### Existing Coverage
- `src/cli/commands/analytics/report/__tests__/session-report.test.ts` — Vitest; mocks SessionsSource, enrichCosts, aggregator, payload-builder and the whole `report-generator.js` (writeReportWithFallback stubbed to invoke writer on given path). Test at lines 89-104 only asserts the path `toContain('codemie-analytics-bob-example-com-abc-123.json')`; nothing asserts the directory.
- `src/agents/core/__tests__/BaseAgentAdapter-session-report.test.ts` — mocks `generateSessionReport`; asserts `outputPath` undefined (line 45), kill-switch, email resolution, non-fatal failure.
- Also `src/agents/core/__tests__/AgentCLI-analytics-report.test.ts`, `src/agents/plugins/__tests__/session-analytics-report-metadata.test.ts`.

### Testing Framework and Patterns
- Vitest with `vi.mock` of modules and dynamic `await import('../session-report.js')` after mocks; `CODEMIE_HOME` env is the documented test-isolation mechanism (see `paths.ts` docs).

### Coverage Gaps
- No test of the default directory (no real filesystem write test); no regression test with temp cwd; report-generator is fully mocked in session-report tests, so a regression test must either assert the mocked path is not under cwd/docs/codemie/analytics and is under `CODEMIE_HOME`, or use a real writer.

---

## 5. Configuration and Environment

### Environment Variables
- `CODEMIE_SESSION_ANALYTICS_REPORT` (`0` disables) — read in BaseAgentAdapter.
- `CODEMIE_HOME` — overrides base dir used by `getCodemiePath()`.
- `CODEMIE_SESSION_ID`, `CODEMIE_PROFILE_CONFIG` — inputs to report generation.

### Configuration Files
- `.gitignore:91` `/docs/codemie/analytics/`. No config key for report output directory exists.

### Feature Flags and Deployment Concerns
- Opt-out via `--no-analytics-report` / env var. No deployment manifests reference the path.

---

## 6. Risk Indicators

- Speculative: the default directory name under CodeMie home is not specified by the ticket (e.g. `getCodemiePath('analytics')` vs `('analytics','reports')`); must be chosen and documented. Note `~/.codemie/analytics` may be unused by existing code; collision with other consumers was not checked beyond a grep of `paths.ts`.
- Speculative: `generateReportJson` may not create missing parent dirs; `~/.codemie/<dir>` may not exist on first run (not verified). Check before relying on it.
- `writeReportWithFallback(..., false)` means an unwritable CodeMie home throws (caught non-fatally by BaseAgentAdapter).
- `session-report.test.ts` mocks report-generator, so path regressions are only visible via assertions on the mocked call args.
- Legacy files already in `docs/codemie/analytics` (ignored by git) remain; ticket says do not use them for new files. The `.gitignore` entry can be left.
- Several historical docs under `docs/superpowers/` still mention the old path; they are records and probably should not be edited.
- Windows/odd `CODEMIE_HOME` values (relative paths) would make the default cwd-relative again; not guarded.

---

## 7. Summary for Complexity Assessment

The change surface is small: one default-path expression in `session-report.ts` (lines 65-68, plus the line 18 JSDoc), consuming the existing `getCodemiePath()` helper in `src/utils/paths.ts`. `BaseAgentAdapter` already omits `outputPath`, so the adapter layer needs no logic change; the opt-out env var and explicit `outputPath` paths are untouched. Documentation touch points are `docs/ANALYTICS-REPORT.md:260` (single live user-facing mention); README and COMMANDS.md do not mention it.

No novel patterns are involved. Tests exist in both named files using Vitest module mocks; neither asserts the default directory, and the report generator is mocked, so the regression test needs to assert the resolved path (with `CODEMIE_HOME` pointed at a temp dir and `process.cwd()` spied/chdir'd to a temp git-like folder) is outside cwd and not under `docs/codemie/analytics`.

Main risks are the unspecified directory name, whether parent directories are created on first write, and stale historical docs. Overall this is a low-complexity, 3-5 file change (1 source, 1 doc, 1-2 test files).

---

## 8. External References

None named by the task
