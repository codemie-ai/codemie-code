DONE

Commit: 226c7bd (fix(analytics): show complete nested session timelines)
ui_touched: true

Changed paths:
- src/cli/commands/analytics/report/client/app.js
- src/cli/commands/analytics/report/template.html

Validation:
- node --check src/cli/commands/analytics/report/client/app.js: passed (exit 0).
- npx vitest run src/cli/commands/analytics/report/__tests__/report-generator.test.ts src/cli/commands/analytics/report/__tests__/session-report.test.ts src/cli/commands/analytics/report/__tests__/report-views.test.ts: 18/18 passed (exit 0).
- Full output: task-7-green.local.log.
- Commit hooks: TypeScript and Gitleaks passed; lint-staged reported no configured matching tasks for the two JS/HTML paths.
- git show --stat HEAD confirms exactly the two owned files.
- Test-first: no, as planned. No new implementation-mirroring tests or browser-driving were added. Stage 7 owns interactive and visual proof.

Interaction behavior / browser assertions:
- Every step renders as a native button at #session-modal .tl-row[data-dispatch]. Native IDs are retained in data-dispatch; legacy steps receive an ordinal fallback. Duplicate display names get occurrence labels but never drive selection. aria-pressed and selected styling follow the exact entry.
- Exact parentId and ownerAgentId links determine indentation; conflicting, missing and cyclic relationships are grouped separately. Guarded traversal keeps every step reachable, including 80+ entries, within a scrollable pane. No dispatch-list truncation. Name counts are precomputed.
- Parent and child buttons in the detail pane navigate exact entries, focus the matching row and scroll it into view. Timeline rows respond to native Enter/Space; Tab focus stays in the modal, Escape closes and focus is restored.
- Captured observedStart/observedEnd define the timeline scale. Legacy sessions retain their activity-envelope fallback. elapsedMs/completedAt/observedEnd determine span; asynchronous acknowledgement duration is never used as completion. Incomplete bars and details identify the observed lower bound and explicitly state completion was not recorded. UTC timestamps include milliseconds; elapsed details also show exact milliseconds.
- Details show own versus inclusive costs/tokens, lifecycle state, invocation ID, recorded depth, acknowledgement/completion evidence, uncertainty and safe parent/child links. Inclusive totals visibly explain overlap with child rows.
- Session Usage allocation shows root own, linked-agent own work across all levels, unlinked usage and the total. It never adds overlapping inclusive values. Unlinked agent IDs are available in an expandable list.
- Native API-equivalent estimates and source-reported costs have distinct labels; legacy missing provenance is identified in session details. Exact session/step costs remain inspectable to eight decimal places; charts retain full numeric series values.
- Client single-session JSON now includes actual s.capturedAt in meta and retains all additive session fields. No parsed transcript data is attached to client entries or export objects. All untrusted labels/IDs use escaping, text nodes or safe DOM attribute setters.

Limitations: no browser or screenshot verification performed in this task by design; parent Stage 7 must verify rendered layout, interaction and historical/live session numbers. Existing report regressions prove serialization, not interactive DOM behavior. No blocking implementation concerns.
