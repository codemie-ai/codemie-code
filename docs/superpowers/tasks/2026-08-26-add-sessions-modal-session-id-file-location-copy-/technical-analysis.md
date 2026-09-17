# Technical Research

**Task**: analytics html-report session-modal
**Generated**: 2026-08-26T00:00:00Z
**Research path**: codegraph

---

## 1. Original Context

I want to add into "codemie analytics --report..." html report into Sessions details modal into header session ID and copy button and below path to session file location and copy button as well. do not run feature verification

---

## 2. Codebase Findings

### Existing Implementations

- `src/cli/commands/analytics/index.ts` — `runAnalytics()`, the `codemie analytics` command handler; owns the `--report` / `--report-format` (`html` | `json` | `both`) / `--report-output` / `--open` flags (see `AnalyticsOptions` in `src/cli/commands/analytics/types.ts`) and calls into `generateReport()`.
- `src/cli/commands/analytics/report/report-generator.ts` — `renderReportHtml()` / `generateReport()`: assembles the self-contained HTML report by string-replacing four placeholders in `template.html` — CSS, vendored Chart.js, the client app JS, and the JSON-embedded `ReportPayload` (`window.__ANALYTICS__`). No server, no external files; the result opens anywhere (its own doc comment).
- `src/cli/commands/analytics/report/template.html` — the static HTML shell containing the placeholder comments (`/* __CODEMIE_CSS__ */`, `/* __CHARTJS__ */`, `/* __CLIENT_APP__ */`, `/*__ANALYTICS_DATA__*/ null`) and the nav/filter chrome (`#view-root`, `#agent-chips`, `#project-select`, etc.) that `client/app.js` attaches to.
- `src/cli/commands/analytics/report/client/app.js` — the entire client app: a single 1403-line vanilla-JS IIFE (no build step, `/* eslint-disable */`), reading `window.__ANALYTICS__` and rendering 7 views (`overview`, `agents`, `projects`, `toolsmodels`, `activity`, `efficiency`, `cost`, `sessions`) plus two modals defined in this same file:
  - `openSessionModal(s, onBack)` (~lines 1083–1216) — **the Sessions details modal** named in the task.
  - `openProjectModal(projectPath, sessions)` (~lines 1224–1281) — a project-sessions list modal that can open a session modal (with a "Back" affordance).
- `src/cli/commands/analytics/report/payload-builder.ts` — `buildPayload()`: flattens the aggregated `RootAnalytics` tree plus the report-time cost index into the flat `ReportSessionRecord[]` that becomes the client's only data source. This is the last point in the pipeline where a session-level field is chosen (or dropped) before reaching the client.
- `src/cli/commands/analytics/report/types.ts` — `ReportSessionRecord` / `ReportMeta` / `ReportPayload`: the wire schema between the generator and the client. `ReportSessionRecord` has no file-path field (see below).
- `src/cli/commands/analytics/report/session-report.ts` — `generateSessionReport()`: a separate, side-effect-free single-session JSON report path (invoked by `BaseAgentAdapter.maybeWriteSessionReport` at session end), built from the same `buildPayload()`/`SessionsSource` pipeline.
- `src/cli/commands/analytics/data-loader.ts` — `RawSessionData` (line 107) and its `agentSessionFile?: string` field (line 120), documented as: "Native agent log path used for cost pricing. Resolved either from a native-discovered session (which carries its log path directly) or from a CodeMie-tracked session's `correlation.agentSessionFile`."
- `src/cli/commands/analytics/native-loader.ts` — `buildNativeRawSession()` (line ~349–415) sets `agentSessionFile: descriptor.filePath` (line 394) when synthesizing a `RawSessionData` from a discovered native transcript.

### Architecture and Layers Affected

- **CLI command layer** — `src/cli/commands/analytics/index.ts`: flag parsing/orchestration for `--report`; unaffected by this task except as the entry point that eventually produces the HTML the modal lives in.
- **Analytics aggregation layer** — `aggregator.ts`, `sources/sessions-source.ts`, `data-loader.ts`, `native-loader.ts`, `cost/cost-enricher.ts`: builds `RootAnalytics` + the per-session cost index (`SessionCostIndex`) from raw session/transcript data. This is where `RawSessionData.agentSessionFile` currently lives and is consumed (by the cost enricher, to locate/price a native log) — it does not currently flow further downstream.
- **Report assembly layer** — `report/payload-builder.ts`, `report/types.ts`, `report/report-generator.ts`: converts the aggregated tree into the embedded `ReportPayload` and inlines it plus static assets into `template.html`.
- **Report client layer (browser-side)** — `report/client/app.js` + `report/template.html` + `report/assets/codemie-bundle.css` + `report/assets/chart.umd.js`: fully offline, vanilla JS, no bundler/build step. **This is the layer the task's change lives in** — specifically `openSessionModal()`'s header-building code (~lines 1089–1122).

### Integration Points

- `src/agents/core/BaseAgentAdapter.ts` → `maybeWriteSessionReport()` calls `generateSessionReport()` (session-report.ts), which shares `buildPayload()`/`ReportSessionRecord` with the CLI `--report` path — any schema change to `ReportSessionRecord` touches both call sites.
- `native-loader.ts` / `SessionsSource` supply `RawSessionData` (including `agentSessionFile`) to `cost/cost-enricher.ts`.
- No external network/service calls exist inside the report client — it is a self-contained static HTML file by design (`report-generator.ts` doc comment: "No server, no external data files — the result opens anywhere").

### Patterns and Conventions

- DOM is built with small local helpers, not a template engine: `el(tag, cls, html)`, `card(title, sub)`, `statsEl(items)` (label/value/sub stat grid), `tableHTML(...)`.
- `esc()` wraps every user-/data-controlled string interpolated into `innerHTML` (XSS defense — the file's own header-building comment states this explicitly: "header — every interpolation through esc(); title is arbitrary user text (XSS vector)").
- The modal header (`.modal-head`) is built as: a left `htxt` block (optional Back button + `.modal-title` + `.modal-meta`) and a right `headBtns` flex row containing action buttons plus the `.modal-close` (✕) button. This is the existing structural slot a new "session ID + copy" line and a new "file location + copy" line would need to fit into.
- The one existing header action button, `.modal-export` ("↓ JSON"), follows a Blob + `<a download>` + `URL.createObjectURL`/`revokeObjectURL` pattern — it is a **download** pattern, not a **clipboard** pattern.
- No `navigator.clipboard` usage, and no "copy button" of any kind, exists anywhere in `app.js` (confirmed across the full file, both modals and all 8 views).

---

## 3. Documentation Findings

### Guides and Architecture Docs

No guide in `.ai-run/guides/` documents the analytics HTML report or its client internals. `.ai-run/guides/architecture/architecture.md` covers the repo's plugin-based 5-layer architecture at a general level; `.ai-run/guides/integration/external-integrations.md` does not mention the analytics report. The AGENTS.md task classifier maps `session`/`metrics`/`analytics`/`transcript`/`sync` keywords to the architecture guide (P0), but that guide does not go into `report/` internals — conventions below are derived entirely from code exploration.

### Architectural Decisions

Inline comments in the source act as the closest thing to recorded decisions:
- `report-generator.ts`: the report must remain a single self-contained offline HTML file (no server, no external data files).
- `report-generator.ts` `renderReportHtml()`: payload is `<`-escaped and injected *last* specifically so no other placeholder replacement can be corrupted by data-derived content — a defense-in-depth XSS/HTML-injection note relevant to any new data field surfaced in the DOM.
- `app.js` `openSessionModal()`: explicit comment that all header interpolations must go through `esc()` because title is "arbitrary user text (XSS vector)".

### Derived Conventions

- New header content follows the existing `el()`/`esc()` idiom, not any framework.
- New action buttons follow the `.modal-export` visual/structural slot in `headBtns` (small button next to the ✕ close button).
- Optional/absent data (e.g., a session with no recoverable log) already has a modeled empty-state convention in this same modal: `usageUnavailableReason` and `hadLog` drive conditional messaging in the "Cost & Time" card rather than silently omitting the row.

---

## 4. Testing Landscape

### Existing Coverage

- `src/cli/commands/analytics/report/__tests__/report-generator.test.ts` — tests `renderReportHtml()`'s pure string assembly.
- `src/cli/commands/analytics/report/__tests__/session-report.test.ts` — tests `generateSessionReport()`.
- `src/cli/commands/analytics/report/__tests__/payload-builder.test.ts` — unit tests `buildPayload()` against a synthetic `RootAnalytics`.
- `src/cli/commands/analytics/report/__tests__/session-source-detector.test.ts` — tests `detectSessionSource()`.

### Testing Framework and Patterns

Vitest (`describe`/`it`/`expect`), per project convention (`.ai-run/guides/testing/testing-patterns.md`). All existing report tests are TypeScript, testing pure functions with synthetic fixtures (e.g. the `session()` factory in `payload-builder.test.ts`).

### Coverage Gaps

- `src/cli/commands/analytics/report/client/app.js` has **zero** test coverage of any kind — it is plain, uncompiled browser JS, not part of the TypeScript build/typecheck surface. Codegraph flags several report-layer symbols (`renderReportHtml`, `ReportSessionRecord`, `ReportMeta`, `ReportWriteResult`) as having "no covering tests found" even at the TS layer.
- `openSessionModal()` specifically (where this task's change lands) has no unit or DOM test; the task explicitly says not to run feature verification, so this gap is not being addressed by this change either.

---

## 5. Configuration and Environment

### Environment Variables

None specific to the report or its client. `CODEMIE_HOME` (read via `getCodemieHome()`/`getCodemiePath()` in `src/utils/paths.ts`) governs where the underlying `~/.codemie/sessions/*.json` and `*_metrics.jsonl` files live that `data-loader.ts`/`native-loader.ts` read from to build `RawSessionData`.

### Configuration Files

- `AnalyticsOptions` (`src/cli/commands/analytics/types.ts`) — CLI flags: `--report`, `--report-format`, `--report-output`, `--open`, `--session`, `--scan-native`, `--include-external`, etc.
- `getDefaultReportPath()` / `getDefaultReportJsonPath()` (`report-generator.ts`) — default output filenames (`codemie-analytics-[email-]<date>.html` / `.report.json`) when `--report-output` is not given.

### Feature Flags and Deployment Concerns

None — the Sessions modal and its buttons render unconditionally from `DATA` (`window.__ANALYTICS__`); there is no flag gating any part of `app.js`.

---

## 6. Risk Indicators

- No existing copy-to-clipboard pattern exists anywhere in the report client to reuse; a copy button is new code, not an application of an established local convention. `navigator.clipboard.writeText` behavior under the report's `file://`-opened, no-server context should be checked — this is unlike the existing `.modal-export` button, whose Blob-download mechanism has no such protocol sensitivity.
- Speculative: the session's file location is not currently part of `ReportSessionRecord` (`report/types.ts`) — it exists upstream only as `RawSessionData.agentSessionFile` (`data-loader.ts:120`, populated in `native-loader.ts:394`), and is consumed solely by the cost enricher to price native logs. Surfacing it in the modal would need this fact threaded through `SessionAnalytics` (`types.ts`) and `payload-builder.ts` into `ReportSessionRecord` before `app.js` could render it — or an alternative such as a client-side derived/conventional path — either way this is a design choice, not something Sections 2/5 assert as already wired.
- Speculative: `agentSessionFile` is not populated for every session (only where a native log was discovered or a tracked session's correlation record resolved one) — the report already models a "session has no recoverable data" state via `hadLog` / `usageUnavailableReason` on `ReportSessionRecord`; a file-location UI element will need an equivalent empty/missing-value state, and deciding what that looks like is a design/spec question.
- `client/app.js` is a single 1403-line, uncompiled, untested vanilla-JS file; `openSessionModal()` itself is a well-isolated ~130-line function, so the header edit is structurally simple, but there is no automated regression safety net, and the task explicitly excludes feature verification for this change.
- No guide file documents the report client's conventions; all findings in Section 2 come from direct code reading rather than a governed pattern doc, so future changes here have no written source of truth to check against beyond the code itself.

---

## 7. Summary for Complexity Assessment

This task touches a single architectural layer in practice: the report client (`src/cli/commands/analytics/report/client/app.js`), specifically the header-building block of one already-isolated function, `openSessionModal()` (~lines 1083–1122 of a 1403-line file). The CLI command layer, the aggregation layer, and the report-assembly layer (`payload-builder.ts`, `report-generator.ts`) are adjacent but not necessarily touched for the session-ID-plus-copy-button half of the request, since `sessionId` is already present on every `ReportSessionRecord` and available to the modal (`s.sessionId`) — that part is a client-only rendering change following the existing `el()`/`esc()`/`headBtns` idiom, with no established copy-to-clipboard code to reuse, only the differently-shaped `.modal-export` download pattern as a structural precedent.

The file-location half is materially different in scope: the underlying fact (`RawSessionData.agentSessionFile`) exists in the pipeline but is consumed only internally by the cost enricher and is dropped before reaching `SessionAnalytics` or `ReportSessionRecord` — it is not currently part of the report's client-facing data model at all. Whether closing that gap requires a schema change through `payload-builder.ts` and `types.ts`, or can be satisfied some other way, is a design decision for the spec/plan stage, not a fact established in this research; Section 6 flags it as speculative precisely so it is not read as an already-discovered requirement.

Test coverage posture is uniformly thin for this area: the report client has no test coverage of any kind (plain browser JS, outside the TS build), and the task explicitly excludes feature verification, so the practical validation path is manual/visual only, with the well-scoped, already-understood `openSessionModal()` function limiting blast radius even without a regression safety net.

---

## 8. External References

None named by the task.
