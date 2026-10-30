# EPMCDME-16441 Split hook forwarding by project: Implementation Plan

**Goal:** Replace first-seen project pinning and event rewriting in the otlp-spool forwarder with one hook request per project (matching `X-CodeMie-Project`), no event modified, all-or-nothing cursor advance.

**Spec:** `spec.md` (same dir). Research: `technical-analysis.md`. `OS/` = `src/providers/plugins/sso/proxy/plugins/otlp-spool/`; tests in `OS/__tests__/`.

**Conventions**
- Commit per task using the repository's existing convention (Conventional Commits with ticket key EPMCDME-16441, per `.ai-run/guides/standards/git-workflow.md`). Stage the task's specific paths only; never `git add -A` / `git commit -a` (tree holds unrelated dirty files); no `--no-verify`; no push, no PR.
- ESM, `.js` import suffixes, `logger` + `sanitizeLogArgs`. Comments say what the code is, no history ("was/now"), no references to docs paths.
- Tests: Vitest, `vi.resetModules()` + dynamic import after mocks (see `forwarder.test.ts`, `project-interleave.test.ts`). Per-task run: `npx vitest run --project unit <file>`. The 14 unit / 4 integration SSO failures on the base are not ours.
- Do not run or add whole-suite gates, browser verification or review tasks; the calling flow owns them.

## Task 1: Top-level project names only; remove the legacy conflict guess

Files: `OS/session-project.ts`, `OS/session-status.ts`, `OS/spool-io.ts` (only if it reads `raw`), `OS/__tests__/{session-project,spool-io,tick-processor}.test.ts`. `otlp.plugin.ts:252` follows via `hookEventProjectNames`, no edit expected.

- `session-project.ts:17-28`: `hookEventProjectNames` collects only the event's top-level string `codemie_project_name` (drop the `raw` collection). `hookRecordIsProject` (`:98-107`) then proves a record by its top-level name alone; blank or missing stays unprovable.
- `session-status.ts:80-86`: delete the `status.project ??= projectConflict[0]` / `delete projectConflict` branch. A stored all-sendable conflict is kept as stored; `parseProjectSeal` at `:87` is unchanged.
- Update tests: `session-project.test.ts:136-143` (raw ignored), `:173-190` replaced by "keeps a stored all-sendable conflict and a valid seal as stored, sets no project", `:192` kept; sealed-filter cases that rely on `raw` names; `spool-io.test.ts` and `tick-processor.test.ts:195` cases that depend on the migration or on `raw` names.

Test-first: yes — `hookEventProjectNames({codemie_project_name:'A', raw:{codemie_project_name:'B'}})` returns `['A']`; a status file with `projectConflict:['A','B']` reads back with `projectConflict` intact and no `project`.

## Task 2: Local re-check admits any sendable project for unsealed hooks

Files: `OS/spool-io.ts:238-260`, `OS/__tests__/spool-io.test.ts`.

- In `isSendAllowed`, for `stream === 'hooks'` with a `send` policy that has no `onlyProject`, accept any `isSendableProjectName(project)` (import from `session-project.ts`) instead of requiring equality with `streamPolicy.project`. Sealed hooks and all OTLP streams keep the case-insensitive equality. The `status.cursors[stream] === range.cursor`, `Boolean(onlyProject) === range.filtered` and `range.end <= limit` checks stay as they are.
- Update the `PendingHookBatch.project` doc comment (`:358-360`) to "bound or sealed project; default for unnamed events".

Test-first: yes — on a bound session, `isSendAllowed(s,'hooks','B',range)` is true for a non-bound sendable `B` and false for an unsendable name; a sealed session and `'logs'` still refuse `B`; stale cursor, wrong `filtered` and `end > limit` still refuse.

## Task 3: Split hook forwarding by project, remove rewriting

Files: `OS/forwarder.ts:236-379`, `OS/__tests__/forwarder.test.ts`.

- Delete `pinEventProject`, the `project` parameter of `unwrapHookRecords`, `HookPayload.rewritten` and the `payload.rewritten` log. `unwrapHookRecords(records)` keeps returning unmodified `hookEvent` bytes joined with `\n`, `containsSessionEnd`, `malformed`.
- Add an exported pure `groupHookRecords(records, boundProject, filtered)` (shares the per-record parse with `unwrapHookRecords`) returning `{ groups: { project: string; ndjson: string }[]; containsSessionEnd: boolean; malformed: number; unsendable: number }`. Rules from the spec: key = lowercased top-level `codemie_project_name`; missing, blank or non-string goes to the bound project's group; groups ordered by first appearance, events in file order; header spelling is `boundProject` when keys match, else first spelling seen; `filtered` (sealed prefix) yields exactly one group headed by `boundProject`; a group whose name fails `isSendableProjectName` is dropped and counted in `unsendable`.
- Rewrite `forwardHooks`: group, debug-log `malformed`, `unsendable` and `batch.dropped`; with no groups, advance the cursor and return `'idle'` as today. Otherwise send groups sequentially via `send(...)` with the batch's shared `{cursor, end, filtered}` range, stop at the first non-`ok` and return it (cursor untouched; `forwardSession` keeps calling `markCredentialsStale` on `'auth-expired'`). Only after every group is `ok`: `advanceCursor(batch.cursor + batch.byteLength)`, then `markSessionEnded` if `containsSessionEnd` (aggregated over all groups, including non-bound ones).
- Fix the "Project the session is bound to" comment at `:31` and the `forwardSession` doc to describe per-group headers.
- `forwarder.test.ts`: delete the rewrite tests (`:80-116`, `:212-231`); add: two requests with matching headers and unmodified bodies, unnamed events in the bound request, case variants in one group with deterministic order, A ok + B failed (cursor unchanged, no `markSessionEnded`), retry resends A with identical bytes, auth-expired marks credentials stale and leaves the cursor, session end in a non-bound group, unsendable group never posted, sealed batch is one filtered request, OTLP streams keep the bound header and bytes.

Test-first: yes — a batch holding events for A and B makes `fetch` run twice with `X-CodeMie-Project` A then B and bodies equal to the original lines, and `advanceCursorMock` is called once with `cursor + byteLength` only after both succeed.

## Task 4: Per-project drop warning, exported drop reasons, backend contract test

Files: `OS/forwarder.ts:36-40,93-167,216`, new `OS/__tests__/backend-drop-contract.test.ts`, `OS/__tests__/forwarder.test.ts:152-210`.

- Export `BACKEND_DROP_REASONS` with a comment naming the source: backend `cli_analytics_project_gate.py` `REASON_*` constants and `postgres/ingestor.py` (`_otlp_result`, hooks discard body). No path to a local checkout.
- `warnOnBackendDrop` gains the `project` argument (passed from `send`); throttle key becomes `${sessionId}:${project.toLowerCase()}:${reason}`; the warn fields gain `project`; 60 s interval and fire-and-forget stay.
- Contract test with hard-coded shapes (never reads the backend): set equals exactly the three strings; hooks body `{"accepted":0,"dropped":N,"reason":R}`; OTLP `partial_success.error_message = R` hand-encoded as protobuf for logs, metrics and traces (as in `forwarder.test.ts:427`) and as JSON `{"partialSuccess":{"rejectedLogRecords":N,"errorMessage":R}}`; each driven through `forwardSession` asserting the warning fires for all three reasons and not for an unknown reason.
- Adapt the throttle tests at `forwarder.test.ts:152-210`: same reason for projects A and B warns twice, repeated A within 60 s warns once.

Test-first: yes — importing `BACKEND_DROP_REASONS` from `forwarder.js` fails today (not exported); two dropped hooks responses for projects A and B in one session yield two warnings carrying `project`.

## Task 5: Real-spool split and partial-failure scenarios

Files: `OS/__tests__/project-interleave.test.ts` (reuse `hookLine`, `seedBoundA`, `cursorsAtEof`).

Add a section against the real spool and real cursors: A and B events produce two requests and the cursor reaches EOF only after both; B fails then succeeds on the next tick with A resent byte-identical; `endedAt` unset until the whole batch is acknowledged, session end in B's group; unnamed events ride in A's request; sealed prefix is still one filtered request; OTLP bytes and header unchanged for a multi-project session.

Test-first: no — end-to-end coverage of behaviour built and unit-tested test-first in Tasks 2-3; it would pass on first run, and is checked by temporarily reverting Task 3's cursor rule locally to see it fail.

## Task 6: Rewrite the architecture doc

Files: `docs/ARCHITECTURE-OTLP-PLUGIN.md`. Re-read lines 74-90 in full first (L83, L85 were not inspected by research).

Rewrite every place that describes pinning or rewriting: forwarder bullet (~L75), atomic ingest (~L78), legacy recovery (~L79), the "Pin-first-seen" bullet (~L80, replace with split-by-project: one request per project, bound project is only the default for unnamed events and the OTLP header), seal/guarantee wording (~L81-85), the hook-side pin remark (~L93-94), the file table entry for `session-project.ts` (~L195). Document cursor semantics (all-or-nothing advance, resend of accepted groups relying on backend `ingest_dedup`, head-of-line blocking), top-level names only, removed legacy guess, per-project drop-warning key. No remaining claim of rewriting or cost attributed to the first project.

Test-first: no — `grep -nEi "first-seen|pin-first|rewrit|pinned" docs/ARCHITECTURE-OTLP-PLUGIN.md` shows only accurate hook-side pin mentions.

## Task 7: Scrub the six committed task docs

Files only: `docs/superpowers/tasks/2026-10-27-epmcdme-16441/{findings-F1,findings-F2,findings-F3,findings-T2,findings-T3}.md` and `handoff-backend.md`. Do not touch any other file in that directory (untracked artifacts) or in the 16435 dirs.

Remove absolute local paths (`findings-T2.md:3`, `findings-F2.md:3`, `handoff-backend.md:108`), backend and CLI commit hashes and version snapshots (`48fa31b56`, `83fad2f6`, `2.49.0-SNAPSHOT...`, `ecab0a11`, `8844a322`, `46bad8dc`, `9e17fbb4`), the developer name at `findings-F1.md:18` and other personal or internal-only names (read `handoff-backend.md` in full, including "ticket owner" at ~L161); make "sibling checkout" wording generic ("the backend repository"). Keep the ticket key and all technical conclusions. Update first-seen/rewrite statements (`findings-F3.md:9`, `findings-T3.md:10`, `handoff-backend.md:60`, `findings-F1.md:11`) to split-by-project; leave the hook-side "session-pinned" remarks that are accurate.

Test-first: no — `grep -nE "/Users/|[0-9a-f]{8,}|SNAPSHOT|<surname>|sibling" ` over the six files returns nothing.

## Task 8: Draft the PR note

File: `<task_dir>/pr-note.md` (task artifact, not committed, not pushed). State: security-reviewed `X-CodeMie-Project` attribution change (now several header values per session, one per project; event rewriting removed; OTLP streams unchanged); cursor semantics and head-of-line trade-off; legacy guess removed; contract test added; daemon restart after upgrade; the PR-body claims about pinning/rewriting are replaced.

Test-first: no — documentation artifact.

## Acceptance traceability

AC1, AC2, AC3, AC4, AC5, AC6 (hooks, sealed, OTLP): T3 (+T5). AC6 sealed/OTLP real-spool: T5. AC7: T2. AC8: T4. AC9: T1. AC10: T1-T5. AC11: T6. AC12: T7. AC13: T8. AC14: each task commits to the current branch with the ticket key, no push or PR (the caller's commit-per-task policy overrides the spec's "one commit" wording).

## Negative-constraint pass

Constraints found: no event rewriting (T3 deletes it; T3 tests assert bodies equal the original lines); no per-project cursors or status schema change (T3 uses the single cursor); no change to OTLP streams, `session-project-pin.ts`, completeness gate, adapters, `OTLP_ALLOW_HOOKS_ONLY_FORWARD` (no task touches them); no change to the sealed mechanism or sendable rule (T1 changes only which names are read; T3 keeps the sealed single group); no client-side access or analytics checks (none planned); no cross-group retry/backoff (T3 stops at first non-ok); no edits to unrelated dirty files, reviews, 16435 dirs or untracked old-task files (T7 names the six files only; staging by path); unsendable names never posted (T3); no `--no-verify`, `git add -A`, push or PR (conventions). No task violates these.
