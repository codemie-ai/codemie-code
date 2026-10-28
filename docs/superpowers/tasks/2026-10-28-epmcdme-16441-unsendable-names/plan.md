# Unsendable names no longer conflict a bound session (CR-002) Implementation Plan

**Goal:** a session bound to a sendable project keeps flowing when a hook names an unsendable project; only the unsendable group is dropped at forward time, with a once-per-session warn.

**Conventions.** Paths are relative to the repo root; `OS/` = `src/providers/plugins/sso/proxy/plugins/otlp-spool/`, `OT/` = `OS/__tests__/`. Commit per task using the repository's existing convention (Conventional Commits `fix(proxy): EPMCDME-16441 ...` or `docs: EPMCDME-16441 ...`, short subject), body ending with the line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Stage specific paths only; never `git add -A`, `commit -a`, `--no-verify`, or push. Do not touch `.codemie/codemie-cli.config.json`, `docs/superpowers/reviews/`, `docs/superpowers/tasks/2026-10-27-epmcdme-16435-*`, or the untracked artifacts of `docs/superpowers/tasks/2026-10-27-epmcdme-16441/`. Task artifacts must contain no absolute local paths, developer names or hostnames. Tasks 1-2 keep the suite green on the OLD rule so Task 3 flips only what the rule itself pins.

## Acceptance criteria

- A session bound to a sendable project is not conflicted by an unsendable name (non-ASCII, padded, control characters); its hooks and OTLP keep flowing under the bound project.
- Only the unsendable hook group is dropped at forward time; a padded variant of the bound name (" A") is its own dropped group, not trimmed into A's.
- An unbound first batch `[unsendable, sendable]` binds the first sendable name; `[unsendable]` alone conflicts (sticky), listing only unsendable names (cut at 8).
- A stored conflict stays a noop; stored seals and conflicts behave as before.
- The forwarder logs one WARN per session with `sessionId` and the group count, never the raw name.
- ARCHITECTURE-OTLP-PLUGIN.md and the draft PR note describe the new rule, including order dependence.

## Task 1: Seed seals and conflicts directly in seal and interleave tests

**Files:** `OT/spool-io.test.ts` (`describe('hooks seal ...')`, ~L400-640), `OT/project-interleave.test.ts` (sections D, E, ~L177-295).
Replace the `switchToB()` path (ingest A then `Bé`) with a helper that, inside `withSessionLock`, uses `writeStatus` to store `project`, `projectConflict` and `projectSeal {v:1, project, hooksEnd}` (hooksEnd = hooks file size), then appends the conflicting B line via `appendSpool`. Keep every assertion, including section E's stale unfiltered snapshot against a seal and the 401 retry refusal. Tests "writes the seal with the exact size before the conflicting append" and "writes no seal when nothing was bound" lose their live path: re-point them to `applyProjectDecision` with a hand-built conflict decision and `hooksSizeBefore`, or to the seeded status. The "warns once at the switch" test now asserts only the discard warn.
Test-first: no — behaviour-preserving test refactor, the suite stays green on the old rule.
Verify: run `OT/spool-io.test.ts` and `OT/project-interleave.test.ts` only. Commit: `fix(proxy): EPMCDME-16441 seed seals directly in tests`.

## Task 2: Make the remaining conflict tests independent of the mixed-batch rule

**Files:** `OT/spool-io.test.ts` (L105, L121, L184, L213, L234, L307, L333, L354, L365-391), `OT/tick-processor.test.ts` (L183, L232).
Where a test only needs "a conflicted session" (late conflict after cursor, restart, ENOSPC retry, discard, legacy scan, snapshots nulled, `isSendAllowed`), build it from an unbound all-unsendable input (`['Bé']`, or legacy disk with only `Bé`) or a seeded `projectConflict`, instead of bound A plus `Bé`. Tests whose point is the bound-to-conflict transition itself (spool-io L70 mixed first batch, interleave A-C) are left for Task 3.
Test-first: no — fixture change, green on both rules.
Commit: `fix(proxy): EPMCDME-16441 decouple conflict tests from mixed names`.

## Task 3: `decideProject` binds on any sendable name

**Files:** `OS/session-project.ts:29-54`, `OT/session-project.test.ts` (L58, L65, L107), `OT/spool-io.test.ts` (L70), `OT/project-interleave.test.ts` (sections A-C).
Test-first: yes — a session bound to `A` plus `Проект` (and `" A"`) yields `noop`, and today yields `conflict`.
Write the failing tests first, then change `decideProject` to: (1) stored conflict -> noop; (2) `status.project` present and sendable -> noop; (3) bind the first sendable candidate; (4) no sendable candidate -> `conflict` with the existing `[...unsendable, ...sendable]` shape (blank names still skipped, case-insensitive dedupe unchanged). Update the doc comment (L29-34) to the new rule and the order dependence. Do not touch `applyProjectDecision`, `appendSpool`'s `sizeBefore`, or `warnConflictStarted`.
Re-point: session-project L58 -> noop for bound A + Проект; L65 `['A','B','Проект']` unbound -> bind A; L107 -> more than 8 unsendable names conflict and the stored list is cut to 8. New unit cases: unbound `['Bé','A']` binds A; `['Bé']` alone conflicts; `[' A']` and `['A\n']` alone conflict; bound A + `' A'` noop; stored conflict + later sendable name stays noop. spool-io L70 -> `['A','Bé']` binds A, no conflict. Interleave A-C invert: snapshot non-null, no conflict, OTLP keeps flowing under A, fetch counts follow. Add one end-to-end test (ingest `A` then `Bé` hook, run the forwarder on mocked `fetch`): A's hooks and OTLP are sent with `X-CodeMie-Project: A`, the `Bé` group is never posted, cursors advance.
Commit: `fix(proxy): EPMCDME-16441 keep bound session on unsendable name`.

## Task 4: Warn once per session when an unsendable group is dropped

**Files:** `OS/forwarder.ts:280-285` (and a helper near `lastDropWarn`, L100), `OT/forwarder.test.ts` (near L396-430).
Test-first: yes — two batches of the same session with an unsendable group produce exactly one `logger.warn` call with `{sessionId, count}`; today none.
New helper, bounded like `warnDiscardOnce` (`OS/spool-io.ts:22-30`), oldest evicted at 1000:

```ts
const warnedUnsendable = new Set<string>();
function warnUnsendableOnce(sessionId: string, count: number): void {
  if (warnedUnsendable.has(sessionId)) return;
  if (warnedUnsendable.size >= 1000) warnedUnsendable.delete(warnedUnsendable.values().next().value as string);
  warnedUnsendable.add(sessionId);
  logger.warn('[otlp-forwarder] hook record groups with a project name that cannot be sent were not sent', ...sanitizeLogArgs({ sessionId, count }));
}
```

Call it beside the existing per-batch debug (keep the debug). Log only `sessionId` and `count`, never the name. Tests: a second session warns again; a name containing a control character or secret-like text is absent from every logger argument (assert via `JSON.stringify` of the calls); use distinct session ids since module memory persists (or `vi.resetModules`).
Commit: `fix(proxy): EPMCDME-16441 warn once when a project group is dropped`.

## Task 5: Update the architecture doc

**Files:** `docs/ARCHITECTURE-OTLP-PLUGIN.md` lines ~77, 78, 79, 80, 82, 83, 85, 196 (re-read ~74-90 in full first).
Test-first: no — documentation.
State: a bound session is never conflicted by unsendable names (that group is dropped at forward time, warn once per session with the count only); the unbound rule (first sendable binds, only-unsendable conflicts, sticky, order dependence `[Bé]` vs `[Bé, A]`); padded variants are separate dropped groups; L79 legacy scan follows the same rule; L82 conflict warn logs counts, not names (fix the "sanitized names" wording); L83 a seal now comes only from a stored status; L85 loss of OTLP applies only to a session with no sendable binding; L196 file-table entry. Add that a session end held by an unsendable group does not mark the session ended while sendable groups exist (abandoned-session grace is the fallback).
Commit: `docs: EPMCDME-16441 unsendable names no longer conflict bound sessions`.

## Task 6: Update the draft PR note and prior task docs

**Files:** `docs/superpowers/tasks/2026-10-28-epmcdme-16441-split-by-project/pr-note.md` (L24, L39), and where they state the old rule in the same directory: `spec.md` (~L19, L21, L49), `technical-analysis.md` (~L37), `plan.md` (~L30). Leave task-N reports alone.
Test-first: no — documentation.
pr-note L24: the unsendable group is not posted, WARN once per session (count only), bound sessions are not conflicted; unbound-only-unsendable still conflicts; order dependence. L39: the sealed-prefix mechanism is unchanged for stored seals, but no ingest path creates a new bound-to-conflict seal. In the other files reword the old rule minimally. No absolute paths, names or hostnames.
Commit: `docs: EPMCDME-16441 update split-by-project notes for unsendable names`.

## Negative-constraint pass

- No change in `evaluateProjectPolicy`, `normalizeStatus`, `groupHookRecords`, `isSendAllowed`, OTLP pinning: Tasks 3-4 touch only `decideProject` and `forwardHooks` logging.
- Seal branch of `applyProjectDecision`, `sizeBefore`, "session switched project" wording kept: Task 3 forbids touching them.
- Never log the raw name: Task 4 asserts it.
- Seal and persisted-conflict coverage not deleted: Task 1 re-seeds instead.
- No whole-suite gate, manual verification, or review tasks; no `git add -A`/`--no-verify`/push: header.
