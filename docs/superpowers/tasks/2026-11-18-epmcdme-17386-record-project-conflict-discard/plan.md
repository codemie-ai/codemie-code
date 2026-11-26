# Record a project-conflict discard as a local loss (EPMCDME-17386) Implementation Plan

**Goal:** When the OTLP spool discards unsent analytics on a project conflict, record it as `status.lastLoss` with reason `project_conflict_discard`, so both status commands and `--json` `analytics.latestDrop` show it.

**Architecture:** One recording site, `applyProjectPolicyLocked`, next to the `no_project` branch. The tick and all snapshot paths already persist through its single `dirty` write. `summarizeSpoolDelivery`/`sessionDrop` carry the reason as an opaque string, so they need no source change.

**Conventions:** Nothing is committed in this run (see "No commits" below). Paths under `src/providers/plugins/sso/proxy/plugins/otlp-spool/` are written as `spool/`. Tests are in scope (the user asked for them and for TDD). Extend existing tests; add no new test file. For each Test-first task: edit the tests, run them and see them fail (RED), write the minimum code, run again (GREEN). Run only the touched files, quiet: `npx vitest run --project unit <files> --reporter=dot` (all touched files are in the `unit` project). Keep full failure output.

## No commits

The user's instruction for this run: nothing is committed, pushed, branched, stashed or staged by the implementer or by any later stage. This overrides the implementer's default of committing per task: every task leaves its changes in the working tree, uncommitted and unstaged, so the user can review and commit them. The only exception is the branch `EPMCDME-17386_record-project-conflict-discard`, which already exists. Do not touch `.codemie/codemie-cli.config.json` (the user's personal file, always dirty, excluded from every diff). If a step cannot proceed without a commit, stop and ask instead of committing.

## Before / After (what the user sees)

Scenario: a Cowork task starts with no folder and is sent under project `klstarproj`; a folder of project `qa-16440-a` is then added. The spool discards the unsent data of that session on 2026-11-17 at 15:40:35 UTC (16:40:35 +01:00). An older, unrelated drop `publication_stopped` was recorded at 09:15:25 +01:00.

`codemie proxy analytics status` — Before:

```
Delivery: healthy
Unsent data: none
Last dropped: publication_stopped (2026-11-17 09:15:25 +01:00)
```

After:

```
Delivery: healthy
Unsent data: none
Last dropped: project_conflict_discard (hooks, 2026-11-17 16:40:35 +01:00)
    The session used folders that belong to different CodeMie projects; part of its data was not sent
```

`codemie proxy status` — Before:

```
Analytics: healthy
  Last dropped: publication_stopped (2026-11-17 09:15:25 +01:00)
```

After:

```
Analytics: healthy
  Last dropped: project_conflict_discard (hooks, 2026-11-17 16:40:35 +01:00)
  The session used folders that belong to different CodeMie projects; part of its data was not sent
```

`codemie proxy status --json` — Before:

```json
"analytics": { "latestDrop": { "reason": "publication_stopped", "at": 1794903325000, "local": true } }
```

After:

```json
"analytics": { "latestDrop": { "reason": "project_conflict_discard", "stream": "hooks", "at": 1794930035000, "local": true } }
```

Unchanged: a session without a project still prints `Last dropped: no_project (...)` with its `Run: set a CodeMie project ...` hint. A conflict that discards nothing prints nothing new. The record stays until the spool sweeper removes the finished session (roughly 15 to 75 minutes after its last activity), or until a newer drop of any session replaces it.

## Acceptance criteria

- A conflict discard of unsent bytes shows as the latest drop (reason `project_conflict_discard`, time, stream) in `proxy status`, `proxy analytics status` and `--json` `analytics.latestDrop`.
- The `no_project` loss is unchanged.
- A conflict that discards nothing records nothing and does not overwrite an earlier loss.

**Negative-constraint pass:**
- Do not reuse the `project_conflict` hold reason: Task 1 adds the distinct `project_conflict_discard`.
- No extra `logger.warn` (exact warn counts are asserted in `spool-io.test.ts:873-887`): Task 1 adds none.
- Not Cowork-specific; `delivery-summary.ts` unchanged: no task touches either.
- `no_project` unchanged; a conflict with no unsent bytes records nothing: Task 1 gates the new branch on `policy.state === 'conflict' && hooksBytes + otelBytes > 0`, leaves the `no_project` branch alone, and its tests keep the `no_project` suite as is.
- No whole-suite run, no git operations at all (no commit, stage, stash, push, branch): none in this plan, and the implementer's per-task commit is switched off.

## Task 1: Loss reason and recording

Test-first: yes — a conflicted session's discard leaves `status.lastLoss` undefined, so the extended spool-io, tick-processor, session-project and delivery-summary assertions fail.

**Files:** `spool/session-project.ts:44-50`, `spool/spool-io.ts:180-188`. Tests: `spool/__tests__/spool-io.test.ts`, `spool/__tests__/tick-processor.test.ts`, `spool/__tests__/session-project.test.ts`, `spool/__tests__/delivery-summary.test.ts`.

- [ ] Extend existing tests first (RED):
  - `spool-io.test.ts:341` "returns null and discards every stream for a conflicted session" (no seal): after the first snapshot, assert `lastLoss` matches `{ reason: 'project_conflict_discard', stream: 'hooks', bytes: hooks size + 6 + the three JSON_SEED sizes }`. After the later `snapshotPendingHookRecords` call, assert `lastLoss` is unchanged (repeat call moves 0 bytes and does not overwrite it).
  - `spool-io.test.ts:388` "nulls all three OTLP snapshots after a late conflict" (sealed): assert `lastLoss` is `project_conflict_discard` with `stream: 'logs'` (hooks prefix is not discarded) and the OTLP-only byte count.
  - `spool-io.test.ts:748` "discards the rest of the hooks once the sealed prefix is consumed": assert the `seal-flushed` pass records `stream: 'hooks'` and the discarded bytes; after the later `A` hook is appended and discarded, assert the later loss wins with that hook's byte count.
  - `spool-io.test.ts:703` "writes no seal when nothing was bound or the conflict comes from a legacy scan": assert `status.lastLoss` is undefined after `appendSpool` detects the conflict (detection alone records nothing; nothing has been discarded yet).
  - `tick-processor.test.ts:211` "records a conflict from a legacy status and discards the backlog": assert `lastLoss` matches `{ reason: 'project_conflict_discard', stream: 'hooks', bytes: hooks size + 3 }` (tick caller).
  - `tick-processor.test.ts:262` "does not rewrite the status of an already discarded conflicted session": read `lastLoss` after the first tick and assert it is `toEqual` after the second tick (a zero-byte repeat does not touch it).
  - `session-project.test.ts:409` "keeps holds ..., the last loss ... across a restart": turn the single `lastLoss` case into `it.each` over `no_evidence_timeout` and `project_conflict_discard` (with a `stream: 'hooks'`), so it proves `LOSS_REASONS` accepts the new reason.
  - `delivery-summary.test.ts:218` "reports the newest drop across sessions: a local no_project loss after a backend discard": parametrize with `it.each` over `no_project` and `project_conflict_discard`, same expectation shape. This goes through `readStatus`/`parseLoss`, so it is RED until the array entry exists.
- [ ] Run the four files; confirm each new assertion fails for the expected reason.
- [ ] In `session-project.ts`, add `'project_conflict_discard'` to the `LossReason` union and to the `LOSS_REASONS` array (after `'no_project'`). Without the array entry `parseLoss` drops the record on reload.
- [ ] In `spool-io.ts`, after the `noProjectLoss` block, add a second block of the same shape gated on `policy.state === 'conflict' && hooksBytes + otelBytes > 0`. It sets `status.lastLoss = { reason: 'project_conflict_discard', at: Date.now(), bytes: hooksBytes + otelBytes, stream: hooksBytes > 0 ? 'hooks' : otelStream }`. Leave the warn section alone and add no logger call. The existing `dirty` write persists it.
- [ ] Run the four files again; all GREEN, and the untouched `no_project` suite (`spool-io.test.ts:890-952`) still passes.

## Task 2: Hint in `describeDrop`

Test-first: yes — `formatDeliveryLines` prints no hint line for `project_conflict_discard`, so the extended `delivery-health` test fails.

**Files:** `src/cli/commands/proxy/delivery-health.ts:177-187`. Test: `src/cli/commands/proxy/__tests__/delivery-health.test.ts:672`.

- [ ] Turn "prints the latest drop with the remedy of a session without a project" into `it.each` over `no_project` (keeping today's expected lines exactly) and `project_conflict_discard` (expected `Last dropped: project_conflict_discard (hooks, 2026-11-13 04:15:00 -05:00)` plus the new hint line). Run the file; RED.
- [ ] Add a second branch to the `hint` expression in `describeDrop` for `drop.reason === 'project_conflict_discard'`, with text `The session used folders that belong to different CodeMie projects; part of its data was not sent`, indented like the existing hint. Keep the `no_project` hint unchanged. Run the file; GREEN.

## Task 3: Docs and comments

Test-first: no — docs/comments only.

**Files:** `docs/ARCHITECTURE-OTLP-PLUGIN.md:91,331`, `docs/COMMANDS.md:271`, comments in `spool/spool-io.ts:143-147`, `spool/session-status.ts:76-79`, `spool/session-project.ts:40-43`, `src/cli/commands/proxy/delivery-health.ts:177`.

- [ ] `ARCHITECTURE-OTLP-PLUGIN.md:91`: extend the "conflicted or unbound session" bullet so a conflict discard is also recorded as a `project_conflict_discard` loss, shown as `Last dropped`.
- [ ] `ARCHITECTURE-OTLP-PLUGIN.md:331`: add a table row after `no_project` in the same columns: loss only, the unsent backlog of a session whose folders belong to different CodeMie projects (the sealed hooks prefix is still sent), stored in `lastLoss` with the stream, shown as `Last dropped`.
- [ ] `COMMANDS.md:271`: extend the local reasons to `no_project` (hint to set a project) or `project_conflict_discard` (a session's folders belong to different CodeMie projects).
- [ ] Update the four stale comments: the `applyProjectPolicyLocked` doc (conflict discard is now recorded as `lastLoss` and still warned once), the `lastLoss` doc in `session-status.ts`, the `LossReason` doc (one line for the new reason), and the `describeDrop` doc (two remedies).

## Verification

- [ ] Touched test files green (commands in Conventions): `spool-io`, `tick-processor`, `session-project`, `delivery-summary` under `spool/__tests__/`, and `src/cli/commands/proxy/__tests__/delivery-health.test.ts`. Do not run the full suite.
- [ ] `npm run lint` (eslint, zero warnings).
- [ ] `npm run typecheck` (`tsc --noEmit`).

## Open question: integration test

`tests/integration/proxy-status-otlp-mismatch.test.ts` needs a real detached daemon from `dist/` (skipped without a build) and is built around the OTLP endpoint mismatch, with no spool seeding. Asserting `analytics.latestDrop.reason` there would mean seeding a conflicted spool for the daemon and driving a tick, which is not cheap and is not an extension of an existing case. This plan skips it and creates no new file. The status-file round trip (session-project), the roll-up (delivery-summary), the tick path and the snapshot paths (spool-io, tick-processor) cover the same chain at unit level. Decision for the user: accept the skip, or approve a new integration file.
