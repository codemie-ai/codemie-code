# Accepted decisions: EPMCDME-16992 / EPMCDME-16993 (PR #779)

Owner decisions on code-review findings (review run 3, 2026-11-09). A review MUST NOT raise these
again as blocking findings unless the stated reopen condition has changed. Pass this file to the
review as an acceptance artifact (spec) together with the ticket text.

Not fixed, by decision. Each was weighed against the risk of the fix; none is a defect in the
ticket acceptance criteria (verified live, isolated, against baseline `main`).

## D-1 (review CR-001): parent lookup in project folders with more than 200 transcripts

- **Behaviour:** more than 200 sibling `.jsonl` files make `resolveInheritedUuids` return `null`
  ("incomplete"). `ensureInherited` retries an incomplete lookup on every pass. Each pass reads the
  tail of up to the 200 most recently modified siblings and streams larger ones whole (about
  250-270 ms per pass for 252 files / 75 MB; 717-798 ms for 68 files / 189 MB with no parent).
  A parent outside the 200 newest siblings is not found.
- **Decision:** not changed. We do not skip or give up on data: ending the retries (or capping the
  work) would make a missed parent permanent, which is the EPMCDME-16992 double count.
- **Why the suggested fix is rejected:** "locate the parent from the child's copied records" does
  not work on real data: in all 4 real parent/child pairs every copied line already carries the
  child's `sessionId`.
- **Reopen only if:** hook latency from this scan is observed in production, or a skip signal for
  sessions without copied history is available (idea: counted lines dated before the session's own
  `SessionStart`; unproven, `sessionStartedAt` was empty in real saved states).

## D-2 (review CR-002, decision_needed): copies reported before the parent is found

- **Behaviour:** if the parent's `continued-in` record is not on disk when a continued session's
  first pass runs, that pass reports the copied lines. They are not retracted; later passes and the
  summary exclude them (verified: first Stop sends the copies, second Stop only the own request).
- **Decision:** not changed. Could not be reproduced in practice: in the 4 real pairs the record is
  written 3-13 s (once 7.5 min) before the child's first own line. Holding events back until the
  lookup is final would delay or drop data for every ordinary session.
- **Reopen only if:** a real session is seen reporting copies on its first pass.

## D-3 (review CR-003): reopen suppression without saved parse state or with offset 0

- **No saved parse state:** a `resume` is treated as a first start by the handlers. In production the
  transition gate stops a `resume` of a session without an evidence record (`resume_unknown`; checked
  live: `resume`/`Stop`/`SessionEnd` -> `stop`, `startup`/`clear` -> `continue`). The remaining case
  (evidence record present, parse state deleted by hand) is rare; nothing in the plugin deletes
  parse state.
- **Offset 0 (state exists, no Stop ever ran):** not a defect. Nothing was reported before, so
  sending the old transcript is correct, not a duplicate (verified live).
- **Decision:** not changed. The suggested fix (move `mainOffset` to the file size on resume) would
  permanently drop work of a session that crashed before its first Stop.
- **Reopen only if:** parse state is shown to be lost in normal operation.

## D-4 (review run 4, CR-004): copied subagent transcripts

- **Behaviour:** if Claude Code copied a parent's subagent transcripts into the continued session's
  folder, their usage could be counted twice.
- **Decision:** not changed, and not valid as a finding. Checked on the 4 real parent/child pairs: no
  subagent file name appears in both folders (parents have 1/8/7/11 subagent files, children
  1/0/1/0). It was never observed, and a dedup rule would be built without a real example, which
  adds overhead and risks breaking correct counting.
- **Reopen only if:** a real continued session is seen with subagent transcripts copied from its parent.

## D-5 (review run 5): raw passthrough hooks on an idle reopened session

- **Behaviour:** hooks that are not lifecycle events (`Notification`, `InstructionsLoaded`, ...) are
  still forwarded at hook time while a reopened session has no activity of its own. This was the
  behaviour before this change.
- **Decision:** not changed. It is not shown that the backend uses these events to admit a session
  into a day's window, or that Claude Code fires them on a reopen. Gating them without that evidence
  risks dropping legitimate events (a `SubagentStop` already counts as activity by design).
- **Reopen only if:** real data shows a `Notification` (or another passthrough event) on an idle
  reopen putting the session back into the reopen day's analytics.

## D-6 (PR review CR-004): failed pass on an idle reopened session

- **Behaviour:** if a pass fails (parse-state lock not acquired within 10 s, or an I/O error), the
  catch returns an empty pass without `suppressLifecycle` / `reopened`. For an idle reopened
  session the plugin then forwards the raw `Stop` / `SessionEnd` hook (and a `SessionStart` resume
  as a start). This was the behaviour on a failed pass before this change.
- **Decision:** not changed. The fix would read the state without the lock, which can be stale: on
  the first active Stop with a failed lock it still says "idle" and would drop a legitimate raw
  Stop (usage is not lost, the next pass sends it). For `SessionStart` it cannot be fixed fully,
  because the `reopened` flag is only persisted under the lock, so a later Stop would not know
  about the reopen anyway.
- **Reopen only if:** a stray `Stop` / `SessionEnd` / `session.start` after a lock timeout on a
  reopen is seen to move a session back into a day's analytics.

## Fixed after review run 4 (for reference, not accepted limits)

- CR-001: a reopen no longer moves the env baseline, so a model/permission-mode change made at
  resume is reported by the first active pass.
- CR-002: an idle reopened `SessionEnd` no longer runs the subagent backstop or the env check, so
  subagent usage is still sent once the session is active again.
- CR-003: tests added for the parent lookup when the `continued-in` record lies before the tail window.
- Review run 5 CR-001: an idle reopened `Stop`/`StopFailure`/`PreCompact` no longer settles deferred
  subagents or moves the env baseline.

Fixed after the PR review: an id-less `<synthetic>` assistant line no longer counts as reopen
activity (synthetic-ness is read from the line, not from the parsed usage); tests added for idle
PostCompact, idle env check, id-less synthetic and a parent record that lands after the first pass;
source comments describe the known limits neutrally.

## Evidence

Isolated harness and results: `C:\Users\OlehPrusak\codemie-eval\` (outside the repo). Related review
verdicts: `docs/superpowers/reviews/2026-11-09-pr779-*/code-review-final.json`.

## Second pass after Preview QA (2026-11-10)

D-1..D-6 above carry over unchanged. #779 was merged, tested on Preview and reverted (#787); what QA
found, and what was decided:

- **16992, Started still the parent's.** Cause confirmed offline and in the live suite: copies were
  dropped by `uuid` only, so a copied line without a `uuid` but with a `timestamp` (`queue-operation`)
  still set the summary's `started_at`. Fixed: every line before the first own line with a `uuid` is a
  copy; a continuation reports nothing until it has done work of its own (`continuationActive`).
- **Local commands are not work.** A user line that only records `/exit`, `/model`, ... no longer counts
  as a genuine turn for the reopen/continuation activity bar (live scenario S2 showed 2 turns and 1 usage
  request for such a continuation). Ordinary-session turn counting is unchanged.
- **16993, duration still grew.** Claude Code's own OTel records are posted straight to the proxy daemon
  and are forwarded for any session with an evidence record, even with no hooks data (confirmed live
  after the spool was swept, scenario S11). The forwarder now holds them for a reopened idle session.
- **D-7 (new): the startup race is bounded, not eliminated.** Records that arrive before the resume hook
  has marked the reopen are kept back for `OTLP_REOPEN_SETTLE_MINUTES` (15 s) when the session had already
  ended. A resume hook slower than that, with Claude Code exporting before it finishes, can still let the
  earliest records through. *Reopen only if* such a leak is seen in real data.
- **D-8 (new): native startup records in the live suite are synthetic.** Capturing them from real
  Claude Code 2.1.319 needs the user's OAuth credentials (token refresh could rotate the real login), so
  they are modelled on the list in the QA comment. *Reopen when* the user agrees to a capture.
- **D-9 (new): a held reopen is dropped after the abandoned-session grace.** If a reopen stays idle for
  `OTLP_ABANDONED_SESSION_GRACE_MINUTES` (60) with no new OTel write, the held records are discarded unsent
  (recorded as `idle_reopen_expired`).
- **D-10 (SUPERSEDED by D-14, fixed 2026-11-11): a reopen that works but never gets a Stop hook.** A reopened
  session is released from the hold only when a hook pass (`Stop`/`SessionEnd`) has seen its own
  activity in the transcript. If the terminal is killed after real work and before any such hook, the
  daemon still sees an idle reopen and drops the held OTel records after the abandoned-session grace
  (60 min), unsent. Accepted: the hook-side events of that session are not affected, and the case needs a
  crash right after a reopen. *Reopen if* such lost records are seen in real data; the fix would be for
  the hold to look at the transcript for own-activity lines before dropping.
- **D-11 (new, code review CR-004): no clamp of a continuation's Started to its `SessionStart` time.**
  The plan proposed `max(started_at, sessionStartedAt)` as a safety net. It was tried and removed: the
  hook's wall-clock can be later than the continuation's first own line (slow SSO or cold start), and the
  clamp then moves Started *later* than the session's real first request; the live suite caught this
  (S3). Positional ownership already covers the known cases. *Reopen if* a real continuation shows a
  Started earlier than its own first line; then clamp only when the gap is larger than a few minutes.
- **D-12 (new, code review CR-007): parent lookup stays at 3 passes and in the child's own folder.**
  A parent record that lands after the third hook pass, or a parent in another project folder, leaves the
  copies counted. Retrying longer would add a sibling-folder scan (up to 200 transcripts) to every hook of
  every ordinary session. *Reopen if* such a continuation is seen in real data.
- **D-13 (SUPERSEDED by D-15, fixed 2026-11-11): the startup-race guard needs the session status.** A reopen after the
  status file was swept, with a resume hook slower than the first OTel export, can still let the startup
  records through. Same family as D-7; a fix needs a new live scenario that sweeps and races.

## Third pass: reviews of 2026-11-11 and the live results of the reporter (2026-11-11)

D-1..D-13 carry over, except D-10 and D-13, which are now fixed (below). Two reviews of this day flagged
`breaking-change` and a finding about project selection (`AgentCLI`, `identity-fields`, the copilot launcher,
`ConfigLoader`). Both ran against a local `main` that was behind `origin/main` and so lacked #782. Against
the current `origin/main` this branch touches only the OTLP plugin and the spool forwarder. The branch was
rebased onto `origin/main` (01f46cf3, after #775) and local `main` brought up to date.

### Fixed

- **D-14 (fixes D-10; reviews CR-001, CR-002, CR-003 of 2026-11-11): the hold looks for real work and cuts safely.**
  A held reopen is released at the first record of real work in its own log stream, with no wait for a `Stop`.
  A record counts only by its exact event name: in the NDJSON stream a log record whose `event.name` is
  `api_request` / `tool_result` (or whose body is `claude_code.<name>`), parsed per line; in the protobuf
  stream the prefixed text `claude_code.api_request` / `claude_code.tool_result`. A bare word elsewhere in a
  payload does not count, and metrics and traces are never looked at. The release stands until the next
  reopen marks the parse state again (`reopenedAt`, set where the resume marks the reopen), whatever the
  hook passes save in between; the memo is bounded by dropping the oldest entries. The expiry after 60 min
  still exists for a reopen that stays idle: before it drops anything it scans everything still unsent for
  work (not just the next 8 MB), it cuts an NDJSON stream at the last whole line and a protobuf stream at its
  end (a newline byte can occur inside a protobuf message), and it leaves a stream alone while earlier records
  of it still wait for a retry. Live: S13 (fails on the earlier hold, passes now).
  *Residual:* after a daemon restart the release memo is gone and the scan starts again at the cursor, so
  records written after the last work record can be held until the next one; a reopen that works and is killed
  leaves only those trailing records (hook_execution_* of the shutdown, no usage) held, dropped after the
  grace. *Unverified:* that Claude Code's real startup records carry neither event name; the live suite's
  startup records are synthetic (D-8). A wrong guess fails closed (the hold waits for a `Stop`, as before).
  To confirm: run the real `claude --resume` check once more on this build.
- **D-15 (fixes D-13): the startup-race guard works after a sweep.** Besides "bytes written after the
  session ended", the hold now recognises a spool file created within the settle window for a session whose
  saved parse state is much older than that file (older by more than the settle time): the status is gone,
  the state file is not. Bounded by the settle time (15 s from the file's creation), so a long turn is not
  held. A brand-new ordinary session is not affected: its state is written within seconds of its first
  record. Live: S14 (7 records leaked on the earlier hold, 0 now). *Residual:* a hook slower than 15 s still
  lets records through (D-7), and a state file touched by an unrelated pass shortly before the reopen defeats
  the age test (the pass would then have marked the reopen or been an ordinary session).
- **Test added (review CR-006):** a continuation with queue lines before and after the copies, a synthetic
  placeholder and `/exit` lines reports nothing on Stop and SessionEnd; once real work follows, its start is
  its own first line (the placeholder Claude Code wrote at the open, as in QA's report), not a copied or queue
  line. A resume without a saved start still counts as a first start by design (D-3).

### Not fixed, with the reason

- **Parent lookup limits, copied subagent transcripts, late `continued-in` record (reviews of 2026-11-10 CR-002 and
  2026-11-11 CR-004): D-1, D-2, D-4, D-12 stand.** A larger change with a high regression risk and a data-loss
  risk: a longer or wider lookup adds a scan of up to 200 transcripts (and other project folders) to every hook
  of every ordinary session, can pick the wrong parent, and any rule that drops uuids as inherited can hide
  real work from a session. Lines already reported are never retracted. Not verified: the
  copied-subagent case was never seen in the 4 real pairs, so a rule would be built without an example.
  Fixing the lookup means scanning other project folders on every hook of every ordinary session (cost) and
  risks choosing the wrong parent (ambiguity), and reported lines can never be retracted anyway. The branch
  is unchanged for the real cases checked.
- **Passthrough hooks (D-5).** Not verified: no real capture shows `Notification` on an idle reopen (the real
  `claude --resume` run sent 0 records). Gating those hooks risks dropping events of ordinary sessions,
  which fire the same hooks.
- **Failed lock forwards the raw Stop/SessionEnd (D-6).** Rare (lock timeout) and not fixable without a
  lock-free marker file, which adds persistence and a new failure mode for a case not seen in practice.
- **Reopen hold reads the parse state without its lock.** A stale read delays a release by one tick; the
  lock would make the forwarder wait on hook processes. Documented in the code.
- **`inheritedUuids` has no size cap; sibling scans repeat while a lookup is incomplete.** Bounded by the
  3-pass limit and the 200-file cap; a cap would drop uuids and bring back double counting.
- **An assistant line without a model counts as activity.** Not verified: only the id-less synthetic
  placeholder was ever seen (already handled); a rule without an example risks hiding real work.
- **Project attribution, "duration ends at the last original activity", the Postgres regression test and the
  backend fixes of comment 16077824.** Outside this repository (backend/UI). On the CLI side an idle reopen
  now sends nothing, so those figures cannot move because of it. Needs the Preview check after merge.

## Fourth pass: review round of 2026-11-11 (CR-001..CR-006)

### Fixed

- **CR-006 / D-14 (a pending delivery blocked the spool for good).** When the idle-reopen grace (60 min) has
  passed and a stream still has an earlier delivery waiting for a retry, the hold is now released (one warn per
  session) instead of returning "hold" with nothing dropped. The cursor cannot tell the earlier records from the
  startup records behind them, so neither is dropped: the forwarder takes its normal course and the earlier
  records are delivered. *Cost:* the startup records of that idle reopen go out with them (the 16993 symptom,
  but only for a session that had a failed delivery and stayed idle for more than an hour).
- **CR-005 / D-14 (the "work seen" memo lived in daemon memory only).** The release is also kept on the session
  status (`reopenWorkAt`, validated in `normalizeStatus`) and is valid while it is not older than the parse
  state's `reopenedAt`, so a daemon restart or an evicted memo entry no longer makes a working session look idle.
  The expiry drop is logged at warn, and only when bytes were really dropped. *By design:* a session that exports
  only metrics or traces is not working in the sense of 16993 (no model request, no tool result), so it still
  expires unsent. *Residual:* if the status file cannot be written, the memory entry still holds until a restart.
- **CR-002 (a parent line with an uncounted uuid passed for the child's own first line).** The parent's uuid
  list now holds every line's uuid except `continued-in` records, not only the counted ones, so a copy of any
  parent line is told as a copy. *Risk:* none seen; a larger set of uuids can only hide more copies, and a fresh
  uuid cannot collide.
- **CR-001 (parent lookup for every session).** `ensureInherited` skips the parent lookup when the transcript
  cannot hold copies: `mayHoldCopiedLines` looks at the first 64 KB and answers "possible" if any timestamped
  line is more than 60 s older than the session's own `sessionStartedAt`; every doubt (no saved start, an
  unreadable file, no timestamped line yet) answers "possible" and the lookup runs as before. So the D-1 cost
  (up to 200 siblings, repeated while the lookup is incomplete) now applies only to sessions that may hold copies.
  *Superseded in the fifth pass:* the skip applied to every folder and double-counted the copies of a parent
  younger than a minute (probe X8); it now applies only to folders with more than 200 transcripts.

### Accepted for now

- **CR-003: the parent lookup can give up (3 misses, more than 200 transcripts, a late `continued-in` record).
  Same as D-1, D-2, D-12.**
  *Reason:* fixing it means scanning more files on the hook path of every ordinary session, or waiting for a
  record that Claude Code writes at an unknown time, and lines already reported are never retracted.
  *Risk if left:* a continuation in a project folder with more than 200 transcripts, or whose parent gets its
  `continued-in` record after the first pass, can still report the parent's copies once (the 16992 double
  counting). Not seen in the 4 real pairs. CR-001 above makes the lookup cheaper for sessions with no copies,
  which lowers the pressure but does not change the limit.
  *Regression / data-loss if fixed:* a wider lookup adds file reads to every hook, can pick a wrong parent
  (then real work is dropped as "inherited": data loss), and retracting reported lines needs a backend change.
- **CR-004: copied subagent transcripts are not filtered (D-4).**
  *Reason:* the architecture doc states this limit; the review points to the 16992 evidence parent, which has two
  subagent transcripts, but no pair checked so far shows a continuation that copied them, so a rule would be
  built without an example.
  *Risk if left:* if Claude Code copies the subagent transcripts into the continuation, agents and subagent
  usage of the parent can be counted again (partial 16992 AC1/AC3 for those lines).
  *Regression / data-loss if fixed:* dropping subagent lines by uuid or by path can hide real subagent work of
  the continuation (data loss); it needs the real layout first. To confirm: inspect a real continued session
  that used subagents.

## Fifth pass: review round of 2026-11-11 (main-3, CR-001..CR-003)

### Fixed

- **CR-001 (second or later resume of a reopen that worked).** The hold returned "nothing to hold" for any reopened
  session whose state said "active", so on a second resume the startup records of Claude Code could go out before
  the `SessionStart(resume)` hook put the state back to idle. `endedAt` could not be used (it is set once, at the
  first end). The status now keeps `lastEndedAt` (every forwarded `SessionEnd`) and the hold applies the settle
  time to bytes written after it, unless a model request or tool result is among them or the session worked after
  that end. Live: S15 (7 records leaked before, 0 now).
  *Residual:* `lastEndedAt` is the time the `SessionEnd` was forwarded, not the time it happened; a resume
  that begins before that forward is not seen (same as `endedAt`). A hook slower than the settle time still
  lets records through (D-7).
- **CR-003 (unsent bytes of the run that ended were held, then dropped).** The status keeps the size of each OTel
  spool file at the last forwarded `SessionEnd` (`endedSizes`). (1) The scan for work starts after that size, so
  unsent work records of the earlier run no longer release the hold of an idle reopen. (2) At expiry, a stream whose
  cursor is still behind that size is not cut: the hold is let go with one warn, like a pending retry, and the
  forwarder takes its normal course. *Cost:* in that corner the startup records of the idle reopen go out together
  with the earlier ones (the 16993 symptom after 60 min of idle, only for a session with an unsent backlog);
  the alternative was to lose the backlog. *Not covered:* a session that was killed with no `SessionEnd` has no
  `endedSizes`; if it also had unsent bytes and is then resumed idle for 60 min, they are still dropped with the
  startup records. Not seen in practice; closing it needs a size recorded on every tick (a status write per
  tick per session). *Not live-tested:* the expiry needs the daemon's 60 min grace set to seconds, and the live
  suite shares one daemon; covered by unit tests with real spool files.
- **CR-002 (killed session resumed, no `SessionEnd`).** A best-effort rule, kept narrow: for a session that is not
  marked reopened, has no `endedAt`, whose parse state is older than the quiet gap (2 min, `OTLP_RESUME_QUIET_MINUTES`)
  compared with the last spool write, bytes written within the settle time are kept back unless a model request or
  tool result is among them. Live: S16 (7 records leaked before, 0 now); S17 shows a session that goes on with
  work after a long quiet is not held (exactly its 2 records go out with no hook pass).
  *Risk and cost:* it is a heuristic. A live session whose hooks were silent for 2+ minutes (a long turn) and
  that writes only non-work records (e.g. periodic metrics) has them delayed up to the settle time (15 s), then
  sent; nothing is dropped and nothing is delayed once a model request or tool result appears. It does not fire
  without a saved start, a saved state, or for sessions of other agents. *Residual:* a resume within 2 min of the
  last hook pass is not recognised; a hook slower than the settle time lets records through (D-7).

### Accepted for now (review, not blocking)

- **Parents continued within about 60 s of their first line are missed, in a crowded project folder only.** The
  copy guard (`mayHoldCopiedLines`, fourth pass CR-001) first skipped the parent lookup for every session with
  no line older than its own start by 60 s. The live probe X8 showed that this double-counts the copies of a
  parent younger than a minute (6 requests, 6036 tokens) in an ordinary folder, which the earlier build handled.
  Fixed: the guard now applies only where the lookup is costly, a folder with more than 200 sibling transcripts
  (`lookupIsCostly`), where the lookup never completes and repeats on every pass. In every other folder the
  lookup runs as before (it completes after the first pass). *Residual:* in a crowded folder a parent younger than
  a minute is still missed. Live: S18 (4 requests / 3091 tokens before the fix, 1 / 88 now); unit test X8.
- **Lock failure at `SessionStart` drops the reopened flag (D-6), lookup under the lock (D-1/D-12), release after
  the grace when earlier records are pending (D-14, now also for `endedSizes`).** Unchanged, see above.
- **Cross-session totals, window admission, class/origin rebinding, D1/D2 regression test.** Backend, see
  `backend-handoff.md`.

## Sixth pass: the remaining gaps (2026-11-11)

### Fixed

- **Parent lookup in a crowded folder (earlier D-1, review CR-003).** The lookup read a 256 KB tail of the 200
  newest siblings only, so in a folder with more than 200 transcripts a parent older than those was never found
  and the lookup repeated on every pass. Now a second step reads a 16 KB tail (`SHALLOW_TAIL_BYTES`) of the
  siblings 201..2000 (`SHALLOW_SCAN_LIMIT`) before the whole-file fallback. The `continued-in` record sits at the
  end of the parent, so 16 KB finds it in the normal case. An incomplete scan of a crowded folder now counts as a
  pass toward the 3-pass cap (`inheritedLookups`), so it stops repeating. *Residual:* a folder with more than 2000
  siblings, or a parent whose record has more than 16 KB after it and that is older than the 200 newest, is still
  not found (the whole-file step still covers only the 200 newest). Unit: `resolveInherited` tests; the parent
  older than the 200 newest is found.
- **Copied subagent transcripts (earlier D-4, review CR-004).** Reversed: it had never been seen on the 4 real
  pairs, but the cost of being wrong is double counting, and the fix is small. When the parent is found, its
  `<parent>/subagents/agent-*.jsonl` ids are saved (`inheritedAgentIds`); a subagent file with the same id in the
  continuation is not reported (`deriveSubagentEvents` returns nothing for it). The continuation's own subagents
  are unaffected. *Risk:* an id clash between a parent subagent and a genuinely new one in the continuation
  cannot happen (ids are random). Live: S19 fails on the previous build (reports `copied` and `own`), passes now.
- **Young parent in a crowded folder.** The copy-guard margin (`COPY_AGE_MARGIN_MS`) went from 60 s to 15 s, so a
  parent only half a minute old is now caught in a crowded folder as well. Margin kept above the few seconds the
  hook runs after the first lines. Unit test: a parent 30 s older is detected; 10 s older is not.

### Not fixed, on purpose (rare, and a fix could bring problems)

- **D-7: a hook slower than the 15 s settle time.** Records of an idle reopen that arrive before a slow
  `SessionStart(resume)` hook marked the session go out. *Rare:* the hook takes 1-3 s in practice (the live runs
  S14 with a slowed hook are held). *Why not fixed:* it needs either a marker the hook writes before Claude Code
  starts (not possible, the hook runs after) or a longer hold, which delays the records of every session that has
  just started by that much.
- **D-2: a late parent record.** If the `continued-in` record is not on disk at the first hook pass, the copies
  of that pass are reported and are not taken back. *Rare:* never seen on the real pairs (the record is written
  before the child is opened). *Why not fixed:* taking back reported data needs a backend change, and a rule on
  the CLI that holds all lines of a new session until the parent is known would delay every session and could hide
  real work if the parent never shows up.
- **A killed session with unsent bytes, resumed idle and left for 60 minutes.** Its unsent bytes have no recorded
  end size (`endedSizes` is written only at a `SessionEnd`), so the 60-minute expiry may drop them together with
  the startup records of the reopen. *Rare:* it needs a kill, an undelivered backlog, a prompt-less resume and
  60 idle minutes. *Why not fixed:* closing it needs a status write on every spool tick, which adds disk writes for
  all sessions and a new place for the status lock to contend.

### Verification

`tsc`, `eslint --max-warnings=0`, vitest for `claude-code-otlp` and the proxy (85 files, 1816 tests), live matrix
19/19, real pairs 4/4. S19 was run against the previous build and fails there.
