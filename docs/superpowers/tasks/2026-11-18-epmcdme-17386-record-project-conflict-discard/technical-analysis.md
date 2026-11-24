# Technical Research

**Task**: otlp-spool lastLoss project conflict proxy status (EPMCDME-17386)
**Generated**: 2026-11-18
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-17386: record a project-conflict discard in the OTLP spool session status so `codemie proxy status`, `codemie proxy analytics status` and `codemie proxy status --json` (analytics.latestDrop) show it as the latest drop.

Ticket text (from the Jira ticket, pasted by the user):
Summary: When the spool discards a session's unsent analytics because of a project conflict, nothing records it as a drop. `codemie proxy status`, `codemie proxy analytics status` and `codemie proxy status --json` (analytics.latestDrop) keep showing an older drop. The only trace is a one-time warning in the debug log. The user has no way to learn that part of a session was lost. Not agent-specific: the spool code is shared by every agent. Reproduced with a Claude Desktop Cowork session (task with no folder, one prompt; then add a folder whose .codemie workspace names another project and send one more prompt).
Actual: debug log WARN "[otlp-spool] session project conflict: unsent analytics discarded" {reason:"seal-flushed", hooksBytes:3162, otelBytes:0}; spool status of that session has projectConflict: ["klstarproj","qa-16440-a"] but lastDiscard: null, lastLoss: null; `proxy status` shows an older unrelated "Last dropped: publication_stopped".
Expected: the conflict discard is recorded like other local losses: "Last dropped: <reason> (<time>)" in both status commands and analytics.latestDrop in JSON, with the time of the discard; the reason tells the user what happened.
Cause stated in the ticket: applyProjectPolicyLocked() in src/providers/plugins/sso/proxy/plugins/otlp-spool/spool-io.ts: when the policy is `unbound` it sets status.lastLoss = {reason:'no_project',...}; when the policy is `conflict` it only calls warnDiscardOnce (a log line) and records nothing. summarizeSpoolDelivery (delivery-summary.ts) builds latestDrop from lastDiscard/lastLoss only.
Acceptance criteria:
1. Given a session whose unsent analytics are discarded on a project conflict, then `codemie proxy status`, `codemie proxy analytics status` and `--json` show it as the latest drop, with its time and a conflict reason.
2. The existing no_project loss is unchanged.
3. A conflict that discards nothing (no unsent bytes) records nothing.
Tests the ticket asks for (planning only; the user must be asked before any test is written or run): unit for the discard path with policy conflict and unsent hook bytes setting status.lastLoss (reason, time, bytes, stream); unit for summarizeSpoolDelivery returning that loss as latestDrop when newest; integration for a spooled session that moves to another project ending with `proxy status --json` analytics.latestDrop.reason = the conflict reason.

Already verified by the caller (confirm, do not re-research from scratch):
- parseLoss in session-status.ts drops records whose reason is not in LOSS_REASONS (session-project.ts), so the new reason MUST be added to LossReason and LOSS_REASONS or the record is lost on daemon restart.
- 'project_conflict' already exists as a HoldReason (used by otlp-reader.ts / otlp-json-reader.ts), so the loss reason name decided with the user is the distinct `project_conflict_discard`.
- describeDrop in src/cli/commands/proxy/delivery-health.ts adds a hint only for no_project; a short hint for the new reason is wanted.
- sweep.ts removes a drained, idle session's status file after a grace period, so the record lives as long as the status does.
Please check specifically: (a) every place that enumerates or switches on LossReason / LOSS_REASONS or on lastLoss.reason (including JSON schema, docs, status renderers, tests that assert the full list), (b) whether applyProjectPolicyLocked can be called repeatedly for the same conflict so that a second call could overwrite lastLoss with 0 bytes or double-record, (c) whether the snapshot-side caller (gateStreamLocked) and the tick caller both go through applyProjectPolicyLocked and persist status, (d) any docs (docs/*.md, CLAUDE/AGENTS guides) that list the loss reasons or the `Last dropped:` output, (e) existing tests for no_project that show the test conventions to follow.

---

## 2. Codebase Findings

All paths below are under `src/providers/plugins/sso/proxy/plugins/otlp-spool/` (`spool/`) unless prefixed otherwise.

### Existing Implementations

**Purpose A: tell the user that part of a session's analytics was dropped locally.**
- `spool-io.ts:148-206` `applyProjectPolicyLocked`: the one place that executes the project policy for tick and snapshots. Discards per `evaluateProjectPolicy`; `spool-io.ts:180-188` sets `status.lastLoss = {reason:'no_project', at: Date.now(), bytes: hooksBytes+otelBytes, stream: hooksBytes>0 ? 'hooks' : otelStream}` only when `policy.state === 'unbound' && bytes > 0`. For `policy.state === 'conflict'` it only reaches `warnDiscardOnce` (`:198-200`, once per session, payload `{sessionId, reason, hooksBytes, otelBytes}`); nothing is stored. `writeStatus` happens when `dirty` (`:190`), where `dirty ||= result.changed` (changed = bytes > 0).
- `spool-io.ts:72-83` `recordLossLocked`: sets `lastLoss = {reason, at, bytes}` (no stream) after discarding; used by `noteStreamHold` (`:126`) for retention-bound hold expiry.
- `delivery-state.ts:37` (`expireDeliveryLocked`), `:86` (`expireCarriedAgeLocked`): also write `lastLoss`.
- `session-status.ts:80` `lastLoss?: {reason: LossReason; at; bytes; detail?; stream?}`; single slot, last writer wins. `:236-248` `parseLoss` drops a record whose reason is not in `LOSS_REASONS` or whose `at` is 0 (confirmed). `:357-358` reads it on load.
- `session-project.ts:44-50`: `LossReason = Exclude<HoldReason,'stamp_pending'> | 'no_evidence_timeout' | 'no_project' | DeliveryLossReason`; `LOSS_REASONS` is a hand-written array of the same members (HOLD_REASONS filtered + `'no_evidence_timeout'`, `'no_project'`, `...DELIVERY_LOSS_REASONS`). `'project_conflict'` is already a member of both (via HOLD_REASONS, `:18`); the `ProofReason` in `otlp-reader.ts:16` uses it for OTLP proof holds, not for this discard.
- `delivery-summary.ts:103-112` `sessionDrop`: builds `{reason, stream?, at, local:true}` from `lastLoss` and compares with `lastDiscard` via `newer()`; no switch on reason, so any `LossReason` flows through. `:114-148` per-session, `:177-178` cross-session `newer`. `LatestDrop.reason` is typed `string`.
- `src/cli/commands/proxy/delivery-health.ts:138` copies `spool.latestDrop` into the health result (all three statuses); `:177-187` `describeDrop` prints `Last dropped: <reason> (<stream, ><time>)` and adds the hint only for `drop.reason === 'no_project'` (`Run: set a CodeMie project for the folder (codemie setup) — sessions without a project are not sent`); `:190-193` `formatDropLines` (used by `proxy status`); `:250` uses `describeDrop` for the analytics report. `analytics-delivery-lines.ts:55` is the `proxy analytics status` / headline consumer. JSON `analytics.latestDrop` is the health object's `latestDrop` field passed through unchanged (no `latestDrop` in `src/cli/commands/proxy/index.ts`; no JSON schema file mentions it).
- `sweep.ts:94` reads `status.lastLoss?.at` only when a status has no spool files (`activityMs === null`), to age it out; otherwise deletion follows `isSessionDrained` + idle grace (`:90-102`). Record lifetime = status lifetime (confirmed).

**Purpose B: knowing a conflict happened (already served, not as a drop).**
- `spool-warnings.ts:22-25` `warnDiscardOnce` (once per session, bounded set of 1000) and `:33-44` `warnConflictStarted`; `session-status.ts:66` `projectConflict` / `projectSeal`. These are what the user sees only in the debug log.
- Backend-side conflict: `lastDiscard` with `reason 'session_project_conflict'` (`session-status.ts:92-95`, `endsSessionDiscard` `:280`), shown by the same `Last dropped` row as `local:false`. Consumer: `src/agents/core/session/legacy-metrics-gate.ts:132` (reads `endingDiscard`/`lastDiscard`, not `lastLoss`).

**Rules `applyProjectPolicyLocked` applies today** (from `evaluateProjectPolicy`, `session-project.ts:265-302`): session hold wins (nothing discarded); bound sends; unbound+evidence sends unprojected; unbound with hooks discards hooks and OTLP; conflict: no seal, or hooks-only disabled, or `cursors.hooks >= min(seal.hooksEnd, hooksSize)` (`seal-flushed`) discards hooks and OTLP; sealed with prefix still pending sends the prefix and discards OTLP only (so a conflict discard of OTLP bytes can happen while `sealed: true`).

Other touched code: none beyond the above.

### Decisions Already in the Code

- Convention for a local loss: write `status.lastLoss` inside the locked section, bytes = bytes actually moved by `discardBacklogLocked`, then persist via the same `writeStatus`; one named bounded reason; warn separately (`spool-io.ts:180-203`, `:81`).
- The no_project loss is recorded only when bytes > 0 (`spool-io.ts:180`), uses `Date.now()` directly (not an injected `now`), and its warning is once per session via a second set `warnedNoProject` (`spool-warnings.ts:8,27`). Alternative of recording every pass: not taken. Reason for the once-only warn: none found beyond the log noise.
- Reason vocabularies are small, bounded and compile-time enumerated; a `lastLoss.reason` must be in `LOSS_REASONS` to survive a reload (`parseLoss`). Recorded in `docs/ARCHITECTURE-OTLP-PLUGIN.md:331`.
- `lastLoss` is one slot, overwritten by each new loss of any kind (`spool-io.ts:80,182`; `delivery-state.ts:37,86`); `stampLoss` is deliberately separate "so it never overwrites `lastLoss`" (`session-status.ts:82-85`). A conflict loss would overwrite an earlier retention/delivery/no_project loss of the same session.
- `no_project` loss `stream` is `'hooks'` when hooks bytes were discarded, else the first OTEL stream that lost bytes (`spool-io.ts:186`, `otelStream ??= stream`).
- Data direction: the user-facing time is `lastLoss.at` (discard time, epoch ms) rendered by `formatTime` in `delivery-health.ts:165`; the conflict start time is not stored anywhere (`projectConflict` is just names).

### Task Statements Checked Against the Code

- "when the policy is `conflict` it only calls warnDiscardOnce and records nothing": holds (`spool-io.ts:198-200`; `noProjectLoss` is gated on `policy.state === 'unbound'`, `:180`).
- "`unbound` sets `lastLoss {reason:'no_project'}`": holds (`spool-io.ts:180-188`).
- "summarizeSpoolDelivery builds latestDrop from lastDiscard/lastLoss only": holds (`delivery-summary.ts:103-112`).
- "parseLoss drops records whose reason is not in LOSS_REASONS": holds (`session-status.ts:239`).
- "'project_conflict' already exists as a HoldReason (otlp-reader.ts / otlp-json-reader.ts)": holds (`session-project.ts:18`, `otlp-reader.ts:16,111,112,253`, `otlp-json-reader.ts:32`); it is therefore already inside `LossReason`/`LOSS_REASONS`, so the new name is a distinct addition, not a reuse.
- "describeDrop adds a hint only for no_project": holds (`delivery-health.ts:183`).
- "sweep.ts removes a drained, idle session's status after a grace period": holds (`sweep.ts:85-103`, `deleteSession` `:105-115`).
- "A conflict that discards nothing records nothing" (AC3): holds for the current structure only because the loss is gated on `bytes > 0`; today's `dirty` is also false in that case (`tick-processor.test.ts:262` covers "does not rewrite the status of an already discarded conflicted session").
- "Not agent-specific: the spool code is shared by every agent": holds (`applyProjectPolicyLocked` has no agent input).
- Reproduction reason `seal-flushed` with `hooksBytes:3162`: consistent with `evaluateProjectPolicy` (`session-project.ts:293-295`).
- "`proxy status` shows an older unrelated Last dropped: publication_stopped": consistent with `newer()` selecting the only recorded drop; `publication_stopped` is a `HoldReason` and so a `LossReason` (`session-project.ts:21`).

### Consumers of Changed Contracts

Contract 1: `LossReason` / `LOSS_REASONS` (`session-project.ts:44-50`).
- `session-status.ts:10,16,80,239,242` (type of `lastLoss`, `parseLoss` filter).
- `spool-io.ts:15,75` (`recordLossLocked` param), `delivery-state.ts:8,62` (type), `session-project.ts:64,94` (`holdOrLose`, `SessionEvidenceDecision`).
- No `switch`/exhaustive map over `LossReason` found; no other file imports `LOSS_REASONS`. No test asserts the full list (searched `src` and `tests` for `LOSS_REASONS`: only the two source files). A JSON schema or generated artifact naming loss reasons: none found (searched `*.json`, `schemas/`, `.ai-run/`, `openwiki/` for `no_project|Last dropped|latestDrop`).

Contract 2: `status.lastLoss` as a record.
- Writers: `spool-io.ts:80`, `spool-io.ts:182`, `delivery-state.ts:37`, `delivery-state.ts:86`.
- Readers: `session-status.ts:357` (load), `delivery-summary.ts:104` (`sessionDrop`), `sweep.ts:94` (age-out when no spool files). `src/agents/core/session/legacy-metrics-gate.ts` reads only `lastDiscard`/`endingDiscard` (`:132`), not `lastLoss`. Test fixtures: `src/agents/core/session/__tests__/legacy-metrics-gate.no-project-loss.test.ts:47` (a `lastLoss` of `no_project` must not by itself end the legacy gate).

Contract 3: `LatestDrop` / `analytics.latestDrop`.
- `delivery-summary.ts:84,177`; `delivery-health.ts:34,138,178,190,250`; `analytics-delivery-lines.ts:55`. All treat `reason` as an opaque string except `describeDrop`'s `no_project` branch.

Contract 4: call sites of `applyProjectPolicyLocked` (question c).
- Tick: `tick-processor.ts:268` (inside `withSessionLock`; after a conflict discard the tick returns without a second write unless `dirty`; `applyProjectPolicyLocked` itself calls `writeStatus` when `dirty`, `spool-io.ts:190-192`).
- Snapshot side: `gateStreamLocked` `spool-io.ts:211-219`, called from `snapshotPendingBytes` (`:372`), `snapshotPendingHookRecords` (`:409`), `snapshotPendingNdjsonRecords` (`:473`), all under `withSessionLock`; the forwarder reaches them via `forwarder.ts:466`. They get the status from `readStatus` and rely on `applyProjectPolicyLocked` to persist (same `dirty` path); none writes the status itself. Both callers therefore persist through the same single function.
- Test-only direct caller: `__tests__/spool-io.test.ts:911`.

Question (b), repeated calls for the same conflict:
- A second call after the discard finds cursors at EOF, `discardBacklogLocked` returns `bytes: 0` (`spool-io.ts:56-60`: only `size > cursor` counts), so `hooksBytes+otelBytes === 0`. With a `> 0` guard like `noProjectLoss` (`:180`) the stored loss would not be overwritten by a zero-byte call, and `dirty` stays false (no rewrite; `tick-processor.test.ts:262` already asserts an unchanged status mtime for a discarded conflicted session).
- Every call within one tick can run the function several times (tick plus up to three snapshot calls per stream pass); only the first sees bytes.
- New bytes appended after the conflict (later hooks appended by `appendSpool`, OTLP chunks, `spool-io.ts:300-325`) are discarded on the next call and would produce a new record with the new byte count and time: the same "keeps the later loss" behaviour as no_project (`spool-io.test.ts:928-941`). The warning stays once per session (`warnedDiscards`), the record would not.
- A first discard can be split across calls: while sealed, only OTLP bytes are discarded (hooks flow); the `seal-flushed` pass later discards the remaining hooks. Each non-zero pass would write its own record, last wins; the byte count of the recorded loss is the last pass only, not cumulative.
- The conflict is not discarded at the moment it is detected (`appendSpool` only sets `projectConflict`/`projectSeal`, `spool-io.ts:314-322`); the discard and its timestamp come from the next tick or snapshot.

### Architecture and Layers Affected

Spool layer (shared by all agents): `session-project.ts` (reason vocabulary), `spool-io.ts` (discard + record), `session-status.ts` (persistence parser, unchanged type shape), `delivery-summary.ts` (roll-up, passes the reason through). CLI layer: `src/cli/commands/proxy/delivery-health.ts` (`describeDrop` hint), `analytics-delivery-lines.ts`, status command (JSON passes through).

### Integration Points

Daemon tick (`tick-processor.ts:268`) and forwarder snapshots (`forwarder.ts:466` -> `spool-io.ts` snapshots) write the status; the CLI process reads status files directly through `summarizeSpoolDelivery` (no daemon call). Status files are shared on disk between processes; `parseLoss` is the cross-process compatibility point (an older CLI/daemon without the new reason would drop the record when reading a status written by a newer one).

### Patterns and Conventions

Named bounded reasons in `as const` arrays; locked mutate-then-write; once-per-session warn sets in `spool-warnings.ts`; ESM `.js` imports, `@/` alias, `sanitizeLogArgs` for log payloads (AGENTS.md).

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `.ai-run/guides/` has no loss-reason or `Last dropped` mention (searched `no_project|Last dropped|latestDrop|lastLoss`). `AGENTS.md` / `CLAUDE.md` do not list loss reasons.
- `docs/ARCHITECTURE-OTLP-PLUGIN.md`: §7.5 table `:316-332` lists hold and loss reasons (`no_project` at `:331`; `project_conflict` hold at `:326`); `:334` says backend refusals such as `session_project_conflict` are `lastDiscard`; prose at `:88-92` describes the conflict policy, "everything else is discarded as before" and the `no_project` recorded loss (line 91); §7.6 `:339` describes `lastLoss` for retention/delivery loss.
- `docs/COMMANDS.md:258` (`Last dropped: no_project` for Cowork), `:271` (list of reasons shown by `Last dropped`: backend `cli_analytics_disabled`, `project_context_required`, `project_context_conflict`; local `no_project` with a hint), `:1916` (`Last dropped` row, time format `YYYY-MM-DD HH:mm:ss +HH:MM`, `--json` keeps epoch ms). `README.md:782` mentions `Last dropped: <reason>` and `no_project` generically.
- Stale-after-change code comments: `spool-io.ts:143-147` ("a conflict discard is warned only"), `session-status.ts:76-79` (lastLoss doc names only retention and no_project), `session-project.ts:40-43` (LossReason doc).

### Architectural Decisions
None recorded for this exact choice; `docs/superpowers/tasks/2026-11-10-epmcdme-16086-delivery-stall-detection/technical-analysis.md:69,101` notes reason vocabularies are kept small and bounded and that `LOSS_REASONS` has no unlisted consumers (consistent with this research).

### Derived Conventions
Docs are updated alongside the reason table; the no_project addition is the template (table row, COMMANDS.md list, hint in `describeDrop`).

---

## 4. Testing Landscape

### Existing Coverage
- `__tests__/spool-io.test.ts:890-952` `describe('applyProjectPolicyLocked — a legacy session without a project')`: helpers `seed(id, {file: bytes})` (writes `x`-filled stream files plus a `createStatus()` with `projectScanned: true`) and `applyPolicy(id)` (reads status, calls `applyProjectPolicyLocked`, re-reads status). Cases: records `no_project` with `bytes: 200, stream: 'hooks'` and no `lastDiscard`/`endingDiscard`; warns once per session while the later loss wins (`bytes: 30`); names the OTel stream (`metrics`) when earlier hooks were already discarded.
- `spool-io.test.ts:~690-888` conflict/seal suite (`switchToB()` helper, sealed prefix, `seal-flushed`, `OTLP_ALLOW_HOOKS_ONLY_FORWARD=false`); `:873-887` asserts exact `logger.warn` call counts (1 at switch, 2 after discard), which a new log line would change.
- `__tests__/tick-processor.test.ts:211-223` (legacy conflict discard asserts cursors), `:262-273` (no rewrite of an already discarded conflicted session), `:275+` seal flush.
- `__tests__/delivery-summary.test.ts:218-234` (newest drop: `no_project` loss vs `lastDiscard`; retention loss with no stream); `session(id, files, mutate)` helper.
- `src/cli/commands/proxy/__tests__/delivery-health.test.ts:262-312` (`latestDrop` carried on healthy/unhealthy/unknown results, `summarizeSpoolDelivery` mocked), `:673-722` (`Last dropped` rendering, time format, hint for `no_project`); `analytics-command.test.ts:404-416`; `index.test.ts:2039-2048`.
- `src/agents/core/session/__tests__/legacy-metrics-gate.no-project-loss.test.ts`.
- `__tests__/session-project.test.ts:413,429-436` (status parsing of `lastLoss`; an unknown reason is dropped).
- Integration: `tests/integration/proxy-status-otlp-mismatch.test.ts` is the only proxy-status integration file that touches the spool; no existing integration test asserts `analytics.latestDrop` (searched `latestDrop` under `tests/`).

### Testing Framework and Patterns
Vitest; dynamic `await import('../x.js')` after mocks; `vi.mock` of `node:fs/promises`, `../spool-paths.js` (`spoolRoot` -> `state.root` temp dir, `mkdtemp`/`rm` per test) and `@/utils/logger.js` (so `logger.warn` is assertable). No fixtures dir needed for the status tests.

### Coverage Gaps
- No test of a conflict-state `applyProjectPolicyLocked` result on `lastLoss` (none exists today; tests check cursors only).
- No test of `describeDrop` for any reason other than `no_project`/`cli_analytics_disabled` beyond opaque pass-through.
- No test that a `lastLoss` with every `LOSS_REASONS` member survives `parseLoss`.
- No integration test of `latestDrop` end to end.

---

## 5. Configuration and Environment

### Environment Variables
- `OTLP_ALLOW_HOOKS_ONLY_FORWARD` (read through `hooksOnlyForwardAllowed()`, `spool-config.js`): `false` makes every conflicted session `reason: 'hooks-only-forwarding-disabled'` and discards the sealed prefix too.
- `OTLP_HELD_RETENTION_MINUTES` (default 1440): bounds retention losses, which also write `lastLoss`.
- Sweep grace values via `abandonedSessionGraceMs()` / `endedSessionGraceMs()` in `sweep.ts` govern how long the record survives.

### Configuration Files
None governing loss reasons.

### Feature Flags and Deployment Concerns
No flag guards this path. Daemon and CLI are separate processes reading the same status files (see Integration Points).

---

## 6. Risk Indicators

- `lastLoss` is a single slot: a conflict loss replaces an earlier retention, delivery or `no_project` loss of the same session (`spool-io.ts:80,182`, `delivery-state.ts:37,86`); and the last pass's byte count is stored, not the sum (sealed pass discards OTLP only; the `seal-flushed` pass discards hooks).
- The record is written at the first discarding call after the conflict, not at conflict detection (`spool-io.ts:314-322` vs `:148-206`); `at` is the discard time.
- Cross-version status: a status written by a build that knows the new reason is read by a build that does not (`parseLoss` drops it silently, `session-status.ts:239`); same applies to the CLI process reading daemon-written files.
- Exact-count `logger.warn` assertions (`spool-io.test.ts:873-887`) would break if the change adds a warn call; `warnDiscardOnce` and `warnNoProjectDiscardOnce` use separate sets (`spool-warnings.ts:7-8`).
- `no_project` branch is keyed on `policy.state === 'unbound'` (`spool-io.ts:180`); the refactor point is shared code for both states, whose existing tests (`spool-io.test.ts:918-951`) pin `bytes`, `stream` and the once-only warn.
- Docs that list loss reasons or the `Last dropped` reasons need the new reason: `docs/ARCHITECTURE-OTLP-PLUGIN.md:331` (and the prose at `:91`), `docs/COMMANDS.md:271`, plus three stale code comments (Section 3).
- Speculative: the unit and integration tests the ticket lists would touch the `spool-io.test.ts` conflict suite, `delivery-summary.test.ts`, `delivery-health.test.ts` and a new integration file; AGENTS.md requires the user to ask for tests before any is written.
- Speculative: `describeDrop`'s time and reason formatting is reason-agnostic except the `no_project` branch, so the hint for a new reason is a one-branch addition there.

---

## 7. Summary for Complexity Assessment

The change sits in one shared module family (`otlp-spool`) plus one CLI formatter. Source touch points found: `session-project.ts` (reason type and array), `spool-io.ts` (`applyProjectPolicyLocked`, the only writer for local project-policy discards), `delivery-health.ts` (`describeDrop` hint), and doc/comment text. `session-status.ts`, `delivery-summary.ts`, the JSON output and the analytics lines carry the reason as an opaque string; no switch, schema, or test asserts the full reason list (searched src, tests, JSON, guides, openwiki).

No new technology: it follows the established no_project pattern (locked mutate, `lastLoss`, same `writeStatus`). Both the tick (`tick-processor.ts:268`) and all three snapshot paths (`gateStreamLocked`) go through `applyProjectPolicyLocked` and persist through its single `dirty` write, so there is one recording site. A repeat call on an already discarded conflict moves 0 bytes and does not dirty the status; new bytes after the conflict would be a new discard.

Test posture is good for the neighbouring behaviour (a no_project suite with `seed`/`applyPolicy` helpers, seal/conflict suite, `delivery-summary` and `delivery-health` suites), but nothing asserts `lastLoss` for a conflict, and no integration test asserts `latestDrop`. Key risks: single-slot `lastLoss` overwrites, last-pass-only byte counts across the seal-then-flush sequence, cross-version `parseLoss` behaviour, exact `logger.warn` counts in existing tests, and five documentation locations that list reasons.

---

## 8. External References

None named by the task. (The user-supplied facts were checked against the code in Section 2, "Task Statements Checked Against the Code".)
