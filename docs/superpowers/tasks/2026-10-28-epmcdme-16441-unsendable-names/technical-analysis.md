# Technical Research

**Task**: otlp-spool decideProject unsendable project names (CR-002, EPMCDME-16441, PR #707)
**Generated**: 2026-10-28
**Research path**: filesystem

---

## 1. Original Context

CR-002 from the automated PR review. In src/providers/plugins/sso/proxy/plugins/otlp-spool/session-project.ts, decideProject currently returns a 'conflict' decision whenever ANY candidate project name is unsendable (an unsendable name is one that cannot be sent as an X-CodeMie-Project header: not printable ASCII / padded), even when the session is already bound (status.project) to a sendable project. With split-by-project forwarding (each project's hook events go in their own request with a matching header; an unsendable group is never posted), one hook from a non-ASCII or padded-named subproject/worktree therefore discards the whole session's unsent OTLP and hooks. New behaviour: when status.project is already bound to a sendable name, unsendable names must NOT turn the session into a conflict; only the unsendable group is dropped at forward time (the forwarder already drops an unsendable group in a bound snapshot with a debug log; verify that and make sure the drop is visible at a sensible log level, once per session, without logging the raw name unsanitised) and the bound project's data keeps flowing. A conflict stays correct when there is NO sendable binding: i.e. unbound session whose first/only names are unsendable (nothing to send under), keep the existing conflict behaviour there, including listing unsendable names first so the MAX_CONFLICT_NAMES slice cannot drop them, and warnConflictStarted wording by cause. Think through and decide, with tests: (a) a session that is unbound and sees [unsendable, sendable] in the same first batch (should it bind to the sendable name and drop only the unsendable group, or conflict? choose the behaviour consistent with 'conflict only when no sendable binding exists' and say so), (b) the sealed-prefix path and the persisted-conflict path (a stored conflict stays as is; do not change normalizeStatus semantics), (c) OTLP streams stay header-pinned to the bound project. Update the unit tests in otlp-spool/__tests__ (session-project.test.ts, forwarder / project-interleave / spool-io tests as needed) with a failing test first, and update docs/ARCHITECTURE-OTLP-PLUGIN.md where it says an unsendable name still conflicts a bound session. Also update docs/superpowers/tasks/2026-10-28-epmcdme-16441-split-by-project/pr-note.md (the draft PR body note; committed) so it no longer says unsendable names conflict a bound session.

(Dirty-tree files named by the requester are out of scope and untouched. Paths below are relative to `src/providers/plugins/sso/proxy/plugins/otlp-spool/` = `OS/` unless stated.)

---

## 2. Codebase Findings

### Existing Implementations
- `OS/session-project.ts` (172 lines). `decideProject(names, status)` (L35-52): noop if `status.projectConflict`; builds case-insensitive distinct candidates from `[status.project, ...names]` (blank skipped); if ANY candidate is unsendable returns `{conflict, names:[...unsendable, ...sendable]}` regardless of `status.project`; else binds `candidates[0]` when unbound; else noop. `isSendableProjectName` = non-blank, no leading/trailing space, `/^[\x20-\x7e]+$/`.
- `applyProjectDecision(status, decision, hooksSizeBefore?)` (L61-74): `bind` sets project; `conflict` (set-once) writes `projectSeal {v:1, project, hooksEnd}` only if `status.project` is sendable AND `hooksSizeBefore` given, then `projectConflict = names.slice(0, MAX_CONFLICT_NAMES=8)`.
- `projectGate` (conflict > bound > unbound) and `evaluateProjectPolicy` (L143-): bound -> `send` hooks+otel under `status.project` (no `limit`, no `onlyProject`); unbound -> hold if hooksSize 0 else discard; conflict -> discard, except live seal -> hooks prefix `limit=end, onlyProject=seal.project`, otel discard. `parseProjectSeal` (L77), `hookRecordIsProject`.
- `OS/spool-io.ts`: `appendSpool` (L~262-312) is the only live caller of `decideProject` with a batch: under the session lock it runs legacy scan if `!projectScanned`, then `applyProjectDecision(status, decideProject(projectNames, status), sizeBefore)` where `sizeBefore` = hooks file size, writes status BEFORE bytes, then `warnConflictStarted` if `!hadConflict && status.projectConflict`. Second caller: `resolveLegacyProjectLocked` (L~137, no size => never seals) used by `applyProjectPolicyLocked` and `appendSpool`. `warnConflictStarted` (L~35-62) picks wording by cause (`unsendable>0` -> "cannot be sent as a header", else "session switched project") and logs counts only, never names. `warnDiscardOnce` (bounded `Set`, `MAX_WARNED_SESSIONS=1000`, oldest evicted) logs the conflict discard at warn once per session. `isSendAllowed` admits any sendable name for unsealed hooks, equality with policy project for OTLP and sealed.
- `OS/hook-records.ts` `groupHookRecords(records, boundProject, filtered)`: key = lowercased top-level `codemie_project_name`, blank/missing/non-string -> bound project; `filtered` (sealed) -> one group; groups failing `isSendableProjectName` are dropped and counted: `unsendable` count and `unsendableSessionEnd`. Padded variants (`" A"`) are separate unsendable groups, not trimmed into the bound group.
- `OS/forwarder.ts` `forwardHooks` (L~262-): after grouping logs `logger.debug('[otlp-forwarder] hook record groups with a project name that cannot be sent were not sent', {sessionId, count})` on EVERY batch (debug, not once per session, count only, name never logged - verified). If no groups remain it advances the cursor and calls `markSessionEnded` when an unsent group held the session end. If other groups exist, an unsent group's session end does NOT mark the session ended (pinned by a forwarder test); abandoned-session grace is the fallback.
- `OS/forwarder.ts` OTLP streams (`forwardOtelStream`) send `pending.project` = `gate.project` = `policy.otel.project` = `status.project`; header-pinned by `isSendAllowed` equality. `groupHookRecords` never touches OTLP.
- `OS/session-status.ts` `normalizeStatus`: keeps `project` only if sendable; keeps `projectConflict` (any string[] , sliced to 8) and a `projectSeal` only if `parseProjectSeal` validates it against the conflict. Must not change.
- Ingest source: `otlp.plugin.ts:264` `appendSpool(sessionId,'hooks',lines,projectNames)` with `hookEventProjectNames`; `copilot-usage-enrichment.ts:102` appends hooks without names (never decides).

### Architecture and Layers Affected
Pure decision layer (`session-project.ts`: `decideProject`, possibly `applyProjectDecision`), ingest/persistence (`spool-io.ts` `appendSpool`, legacy scan, `warnConflictStarted`), forwarder logging (`forwarder.ts` `forwardHooks`), docs. `evaluateProjectPolicy`, `normalizeStatus`, `groupHookRecords`, `isSendAllowed`, tick-processor need no behavioural change.

### Integration Points
`otlp.plugin.ts` -> `appendSpool` -> `decideProject`/`applyProjectDecision` -> status file -> `evaluateProjectPolicy` (tick via `applyProjectPolicyLocked`, snapshots via `gateStreamLocked`, `isSendAllowed`) -> `forwarder.ts`. Every consumer of a `conflict` decision is `applyProjectDecision` (only 2 call sites: spool-io L138 legacy, L303 live).

### Patterns and Conventions
Pure functions + status mutated under session lock, status written before bytes; once-per-session warn via bounded in-memory Set (`warnDiscardOnce`); throttled map in forwarder (`lastDropWarn`, cleared past 256); log args go through `sanitizeLogArgs` (`src/utils/security.ts:239`), which masks secrets only - it does NOT escape control characters or truncate, so a raw name must not be logged; log counts only (current convention).

---

## 3. Documentation Findings

### Guides and Architecture Docs
`.ai-run/guides/testing/testing-patterns.md` (Vitest, co-located `__tests__`, nested describe, AAA). `docs/ARCHITECTURE-OTLP-PLUGIN.md` is the design doc for this area (243 lines).

### Doc lines that state an unsendable name conflicts a bound session (all in ARCHITECTURE-OTLP-PLUGIN.md)
- L77: status fields: `projectConflict` "(unsendable names seen...)"; "a non-blank name that cannot be a header value ... is a conflict on its own".
- L78: atomic ingest: "only an unsendable name conflicts"; "When a bound session turns into a conflict, the seal is recorded in that same status write".
- L79: legacy recovery: "the first distinct name binds, none stays unbound, an unsendable name conflicts".
- L80: split-by-project: "A group whose name cannot travel ... (debug log with the count)" - update to warn-once.
- L82: "A conflict (an unsendable name: ...) is logged once at warn with the sanitized names" (code logs counts only - fix wording too).
- L83: Hooks seal: "when a session that was bound to project A turns into a conflict ... A session that was never bound (a mixed first batch, blank names)..." - seal now only from a stored status.
- L85: guarantee and limits: "a session that becomes unsendable loses the OTLP-derived metrics"; "no new OTLP attempt once the conflict is persisted".
- L196: file table "unsendable-name conflict resolution (`decideProject`...)".
- Committed task docs: `docs/superpowers/tasks/2026-10-28-epmcdme-16441-split-by-project/pr-note.md` does NOT say a bound session conflicts verbatim; the lines needing change are "A group whose name cannot travel as a header is never posted (debug log, counted)" (Cursor semantics) and "Not changed: ... the sealed-prefix mechanism". `split-by-project/spec.md` L19 ("Ingest already turns it into a session conflict") and L21 ("Session conflict, now. Only an unsendable top-level name"), L49, plus `technical-analysis.md` L37 and `plan.md` L30 describe the old rule (all committed; task-N-reports are historical, leave). The dirs 2026-10-27-epmcdme-16441 and docs/superpowers/reviews are dirty/untracked: do not touch.

### Architectural Decisions
Spec (split-by-project/spec.md L19) deliberately treated the forwarder's unsendable drop as "defensive for corrupt/legacy disk state" because ingest conflicted first. CR-002 inverts that: the forwarder drop becomes the normal path for a bound session.

### Derived Conventions
Keep conflict names `slice(0, 8)` with unsendable first; warnings sanitised and count-only; debug for per-tick noise, warn once per session for user-visible data loss.

---

## 4. Testing Landscape

### Existing Coverage (tests that pin the old behaviour and must change)
- `__tests__/session-project.test.ts`: L58 "lists the unsendable name first when it conflicts next to the binding" (bound A + Проект -> must become noop); L65 unbound `['A','B','Проект']` conflict (-> bind A); L107 "keeps an unsendable name when the conflict list is cut" (12 sendable + Проект; must use >8 unsendable names, since sendable now binds); L95 and L258 (`applyProjectDecision` with hand-built conflict decisions - still valid unit tests of the seal write); `it.each([' A','A\n','Проект'])` alone -> conflict stays.
- `__tests__/spool-io.test.ts`: L70 mixed first batch `['A','Bé']` (-> now binds A); L105 late conflict after cursor (-> no conflict); L121 restart; L184 legacy disk A+Bé (-> binds A); L213 and L234 (conflict before bytes land / ENOSPC retry); L307 conflicted-session discard; L333 legacy-scan snapshot; L354 "nulls all three OTLP snapshots after a late conflict"; L365-L391 `isSendAllowed` after conflict; whole `describe('hooks seal ...')` L400-L640 builds its sealed session through ingest via `switchToB()` (A hooks then `Bé`), so every test there needs a status-seeding helper instead (write `projectConflict` + `projectSeal` via `writeStatus`, then `appendSpool` the B line); tests "writes the seal with the exact size before the conflicting append" (L431) and "writes no seal when nothing was bound..." (L451) lose their live path; "warns once at the switch..." (L~620) changes (no switch warn).
- `__tests__/project-interleave.test.ts`: sections A (L101, L117), B (L135), C (L162), D (L177-L295), E (L214) all create the conflict by ingesting `Bé` after bound A. A-C assertions invert (snapshot non-null, no conflict, OTLP continues, fetch count changes). D/E (seal races, 401 retry refusal, restart reads seal back) remain valuable for the persisted-conflict path but need the seal injected via `withSessionLock` + `writeStatus` instead of ingest. Section F (multi-project, OTLP header-pinned, L427) unaffected.
- `__tests__/tick-processor.test.ts`: L183 "records a conflict from a legacy status" and L232 use legacy disk `A`+`Bé` (-> binds A; need an all-unsendable fixture to keep conflict coverage); the `hooks seal` describe (L~245-) writes statuses directly: unaffected.
- `__tests__/forwarder.test.ts`: L396/L407/L418/L430 (unsendable group dropped, cursor advances, session-end handling) stay green; logger is mocked (`logger.warn/debug` are `vi.fn`), so the new once-per-session warn is testable there. `hook-records.test.ts` L112, L125 unchanged.

### Testing Framework and Patterns
Vitest, `@group unit`; real temp spool root via mocked `spool-paths.js`, real lock; `vi.resetModules()` resets module-level warn memory; forwarder tests mock `snapshotPendingHookRecords`, `fetch`, `logger`.

### Coverage Gaps
No test asserts: bound session survives an unsendable name end to end (ingest -> status stays unconflicted -> A hook sent, unsendable group not posted, OTLP still sent under A, cursors advance); no test for a once-per-session forwarder warn; no test for `[unsendable, sendable]` unbound batch; no test that a stored conflict stays noop when later sendable names arrive (partially covered by L80).

---

## 5. Configuration and Environment

### Environment Variables
`OTLP_ALLOW_HOOKS_ONLY_FORWARD` (`spool-config.ts`, `hooksOnlyForwardAllowed()`): affects only sealed/conflict policy; no new env var is implied.

### Configuration Files
None relevant. No feature flags. Status file schema unchanged (`project`, `projectConflict`, `projectSeal`, `projectScanned`).

### Feature Flags and Deployment Concerns
Daemon restart picks up new code; existing persisted conflicts/seals remain as stored.

---

## 6. Risk Indicators

- Speculative: design for (a) unbound `[unsendable, sendable]` in one batch: bind the first sendable name and drop only the unsendable group; this is the only choice consistent with "conflict only when no sendable binding exists". Resulting order-dependence is inherent and should be documented: first batch `[Bé]` conflicts (sticky) while `[Bé, A]` binds A; later sendable names never repair a stored conflict.
- Speculative: proposed `decideProject`: noop if stored conflict; noop if `status.project` is sendable; else bind the first sendable candidate; else conflict with the unsendable names (non-blank, deduped) and keep the `[...unsendable, ...sendable]` shape. The "unsendable first" ordering and `MAX_CONFLICT_NAMES` slice become vacuously true (conflict names are now all unsendable) but should stay and keep a test with >8 unsendable names.
- Speculative: after the change no live ingest path produces a bound->conflict transition, so the seal-writing branch of `applyProjectDecision` and the `sizeBefore` stat in `appendSpool` become unreachable in production (seals only come from already-persisted statuses). Keeping them is the minimal, safe choice (requester says stored conflicts/seals stay); removing is a possible follow-up. The "session switched project" wording in `warnConflictStarted` likewise only reachable via legacy/hand-built decisions; keep (not pinned by any test).
- Forwarder drop visibility: today debug-only, every batch, count only. Needs a warn once per session (new bounded Set like `warnDiscardOnce`, or share one helper), carrying `sessionId` and group count only, never the name (sanitizeLogArgs does not escape control chars). Keep per-batch debug for repeats. Must also cover the legacy-scan/unsendable path in a bound snapshot.
- Session end held by an unsendable group (e.g. SessionEnd from the non-ASCII worktree) is not marked when sendable groups exist; it relies on the bound project's own end or abandoned-session grace. Not new, but now reachable in normal flow.
- Wide test churn (spool-io seal describe, interleave A-E) because the old fixtures create seals through ingest; risk of silently dropping the persisted-conflict race coverage (E: stale unfiltered snapshot vs seal, 401 retry) if the helper rewrite is sloppy.
- Failing-test-first order: session-project unit tests first (3-4 flips), then spool-io/interleave integration flips, then forwarder warn test.
- Docs: 8 lines in ARCHITECTURE-OTLP-PLUGIN.md plus pr-note.md plus (optionally) split-by-project spec.md L19/L21/L49, technical-analysis.md L37.

---

## 7. Summary for Complexity Assessment

The change is a small, localized behaviour change in one pure function (`decideProject`, ~10 lines) plus a once-per-session warn in `forwarder.ts` `forwardHooks` (~10-15 lines). `evaluateProjectPolicy`, `normalizeStatus`, `groupHookRecords`, `isSendAllowed` and OTLP stream pinning need no code change: a bound session stays `bound`, OTLP stays header-pinned to `status.project`, and the existing forwarder logic already drops an unsendable group, advances the cursor and handles the session end. Layers: pure decision, ingest/persistence (read-only effect), forwarder logging, docs. No novelty; the main design question (a) is settled by the rule "conflict only when no sendable binding exists" (bind the first sendable name).

Test surface dominates the effort: the old rule is pinned in session-project.test.ts (3 tests), spool-io.test.ts (about 10 tests, plus the whole seal describe that builds sealed sessions through ingest), project-interleave.test.ts (sections A-E) and tick-processor.test.ts (2 tests). Seal/persisted-conflict coverage must be preserved by seeding statuses directly. New tests: bound survives unsendable (unit + end to end), unbound `[unsendable, sendable]`, all-unsendable conflict with >8 names, stored conflict stays noop, forwarder warn once per session without the raw name.

Risks are modest: dead-ish seal-write code, order-dependence of first-batch conflicts (documented), session-end held by an unsendable group, and doc consistency (8 architecture lines, pr-note, optionally spec/analysis of the prior task). Size: small-to-medium, driven by test rewrites rather than production code.

---

## 8. External References

None named by the task
